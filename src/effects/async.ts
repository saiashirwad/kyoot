import { InterruptedError, makeOp, succeed } from "../core.ts";
import { fail } from "./fail.ts";
import { Cause, Result } from "../result.ts";
import type { AnyKyoot, Kyoot } from "../model.ts";
import type { AsyncOp } from "../runtime.ts";
import type { AsyncOnly, Merge, Row, Simplify } from "../types.ts";

// Async — the concurrency slot. The fiber layer lives entirely here; sync
// programs never touch it. Tier 1: fork/join/await, race, timeout. JS's
// event loop is the scheduler — await points are the yield points; no run
// queue, no ops budget, no preemption (a hot loop in one fiber starves the
// rest — documented sharp edge).

function asyncOp(op: AsyncOp, kont?: (v: any) => AnyKyoot): Kyoot<any, { async: true }> {
  return makeOp("async", op, kont) as Kyoot<any, { async: true }>;
}

export function suspend<A>(
  f: (resume: (a: A) => void, signal: AbortSignal) => void,
): Kyoot<A, { async: true }> {
  return asyncOp({ execute: (rt) => new Promise<A>((resolve) => f(resolve, rt.signal)) });
}

export function fromPromise<A>(f: (signal: AbortSignal) => Promise<A>): Kyoot<A, { async: true }> {
  return asyncOp({ execute: (rt) => f(rt.signal) });
}

export function sleep(ms: number): Kyoot<void, { async: true }> {
  return suspend((resume, signal) => {
    const t = setTimeout(resume, ms, undefined);
    signal.addEventListener("abort", () => clearTimeout(t), { once: true });
  });
}

// ---------------------------------------------------------------------------
// Tier-1 fiber: the interpreter loop reified as an object.
// ---------------------------------------------------------------------------

export type FiberState = "running" | "done" | "interrupted";

export interface Fiber<A> {
  readonly state: FiberState;
  // Join: wait for the fiber's value, rethrowing its failure.
  readonly join: Kyoot<A, { async: true }>;
  // Await: wait for the fiber's outcome as a Result.
  readonly await: Kyoot<Result<unknown, A>, { async: true }>;
  readonly interrupt: Kyoot<void, { async: true }>;
}

class FiberImpl<A> implements Fiber<A> {
  state: FiberState = "running";

  readonly promise: Promise<A>;
  private readonly interruptFiber: () => void;

  constructor(promise: Promise<A>, interruptFiber: () => void) {
    this.promise = promise;
    this.interruptFiber = interruptFiber;
    void promise.then(
      () => (this.state = "done"),
      (e: unknown) => {
        this.state = e instanceof InterruptedError ? "interrupted" : "done";
      },
    );
  }

  get join(): Kyoot<A, { async: true }> {
    return asyncOp({ execute: () => this.promise });
  }

  get await(): Kyoot<Result<unknown, A>, { async: true }> {
    return asyncOp({
      execute: () =>
        this.promise.then(
          (a): Result<unknown, A> => Result.ok(a),
          (e): Result<unknown, A> =>
            e instanceof InterruptedError
              ? { ok: false, cause: Cause.interrupted() }
              : Result.defect(e),
        ),
    });
  }

  get interrupt(): Kyoot<void, { async: true }> {
    return asyncOp({
      execute: () => {
        this.interruptFiber();
        return Promise.resolve();
      },
    });
  }
}

// Forked computations must be handled down to at most `async` — a fiber is
// an independent interpreter loop, so no outer handler can see its ops.
export function fork<A, S extends Row>(
  k: Kyoot<A, S> & AsyncOnly<S>,
): Kyoot<Fiber<A>, Simplify<Merge<S, { async: true }>>> {
  return asyncOp({
    execute: (rt) => {
      const h = rt.spawn(k as AnyKyoot);
      return Promise.resolve(new FiberImpl(h.promise as Promise<A>, h.interrupt));
    },
  }) as Kyoot<Fiber<A>, Simplify<Merge<S, { async: true }>>>;
}

// First to complete wins.
export function race<A, S1 extends Row, S2 extends Row>(
  a: Kyoot<A, S1> & AsyncOnly<S1>,
  b: Kyoot<A, S2> & AsyncOnly<S2>,
): Kyoot<A, Simplify<Merge<Merge<S1, S2>, { async: true }>>> {
  return asyncOp({
    execute: (rt) => {
      const fibers = [rt.spawn(a as AnyKyoot), rt.spawn(b as AnyKyoot)];
      return Promise.race(fibers.map((f, i) => f.promise.then((r) => ({ i, r })))).then(
        ({ i, r }) => {
          fibers[1 - i]!.interrupt();
          return r;
        },
      ) as Promise<A>;
    },
  }) as Kyoot<A, Simplify<Merge<Merge<S1, S2>, { async: true }>>>;
}

export function all<A, S extends Row>(
  ks: ReadonlyArray<Kyoot<A, S> & AsyncOnly<S>>,
): Kyoot<ReadonlyArray<A>, Simplify<Merge<S, { async: true }>>> {
  return asyncOp({
    execute: (rt) => {
      const fibers = ks.map((k) => rt.spawn(k as AnyKyoot));
      return Promise.all(fibers.map((f) => f.promise)).then(
        (results) => results,
        (e: unknown) =>
          Promise.allSettled(
            fibers.map((f) => {
              f.interrupt();
              return f.promise;
            }),
          ).then(() => {
            throw e;
          }),
      ) as Promise<ReadonlyArray<A>>;
    },
  }) as Kyoot<ReadonlyArray<A>, Simplify<Merge<S, { async: true }>>>;
}

export class TimeoutError extends Error {
  readonly _tag = "TimeoutError";
  readonly ms: number;

  constructor(ms: number) {
    super(`timed out after ${ms}ms`);
    this.name = "TimeoutError";
    this.ms = ms;
  }
}

// Race k against the clock; on timeout the computation fails with a typed
// TimeoutError in the `fail` slot.
export function timeout<A, S extends Row>(
  ms: number,
  k: Kyoot<A, S> & AsyncOnly<S>,
): Kyoot<A, Simplify<Merge<S, { async: true; fail: TimeoutError }>>> {
  const TIMEOUT: unique symbol = Symbol("kyoot.timeout");
  return asyncOp(
    {
      execute: (rt) => {
        const f = rt.spawn(k as AnyKyoot);
        let timer: ReturnType<typeof setTimeout>;
        const tick = new Promise<typeof TIMEOUT>((resolve) => {
          timer = setTimeout(resolve, ms, TIMEOUT);
        });
        return Promise.race([f.promise, tick]).then(
          (r) => {
            if (r === TIMEOUT) {
              f.interrupt();
            } else {
              clearTimeout(timer!);
            }
            return r;
          },
          (e: unknown) => {
            clearTimeout(timer!);
            throw e;
          },
        ) as Promise<unknown>;
      },
    },
    (r) => (r === TIMEOUT ? (fail(new TimeoutError(ms)) as AnyKyoot) : succeed(r)),
  ) as Kyoot<A, Simplify<Merge<S, { async: true; fail: TimeoutError }>>>;
}
