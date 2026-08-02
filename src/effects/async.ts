import { makeOp, succeed } from "../core.ts";
import { fail as abortFail } from "./abort.ts";
import { Result } from "../result.ts";
import type { AnyKyoot, Kyoot } from "../model.ts";
import type { AsyncOp } from "../runtime.ts";
import type { AsyncOnly, Merge, Row, Simplify } from "../types.ts";

// Async — the concurrency slot. The fiber layer lives entirely here; sync
// programs never touch it. Tier 1: fork/join/await, race, timeout. JS's
// event loop is the scheduler — await points are the yield points; no run
// queue, no ops budget, no preemption (a hot loop in one fiber starves the
// rest — documented sharp edge).
//
// Interruption is tier 2 and deliberately absent. `AbortSignal` is in the
// op signature from day one so adding interruption later does not break
// every async effect.

function asyncOp(op: AsyncOp, kont?: (v: any) => AnyKyoot): Kyoot<any, { async: true }> {
  return makeOp("async", op, kont) as Kyoot<any, { async: true }>;
}

export function suspend<A>(
  f: (resume: (a: A) => void, signal: AbortSignal) => void,
): Kyoot<A, { async: true }> {
  return asyncOp({ execute: (rt) => new Promise<A>((resolve) => f(resolve, rt.signal)) });
}

export function sleep(ms: number): Kyoot<void, { async: true }> {
  return suspend((resume) => {
    setTimeout(resume, ms, undefined);
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
}

class FiberImpl<A> implements Fiber<A> {
  state: FiberState = "running";

  readonly promise: Promise<A>;

  constructor(promise: Promise<A>) {
    this.promise = promise;
    // 'interrupted' is unreachable at tier 1; it exists so the state
    // machine's shape is stable when tier 2 lands.
    void promise.then(
      () => (this.state = "done"),
      () => (this.state = "done"),
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
          (e): Result<unknown, A> => Result.defect(e),
        ),
    });
  }
}

// Forked computations must be handled down to at most `async` — a fiber is
// an independent interpreter loop, so no outer handler can see its ops.
export function fork<A, S extends Row>(
  k: Kyoot<A, S> & AsyncOnly<S>,
): Kyoot<Fiber<A>, Simplify<Merge<S, { async: true }>>> {
  return asyncOp({
    execute: (rt) => Promise.resolve(new FiberImpl(rt.spawn(k as AnyKyoot).promise as Promise<A>)),
  }) as Kyoot<Fiber<A>, Simplify<Merge<S, { async: true }>>>;
}

// First to complete wins. The loser keeps running — there is no
// interruption at tier 1.
export function race<A, S1 extends Row, S2 extends Row>(
  a: Kyoot<A, S1> & AsyncOnly<S1>,
  b: Kyoot<A, S2> & AsyncOnly<S2>,
): Kyoot<A, Simplify<Merge<Merge<S1, S2>, { async: true }>>> {
  return asyncOp({
    execute: (rt) =>
      Promise.race([
        rt.spawn(a as AnyKyoot).promise,
        rt.spawn(b as AnyKyoot).promise,
      ]) as Promise<A>,
  }) as Kyoot<A, Simplify<Merge<Merge<S1, S2>, { async: true }>>>;
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
// TimeoutError in the `abort` slot. The timed-out branch keeps running.
export function timeout<A, S extends Row>(
  ms: number,
  k: Kyoot<A, S> & AsyncOnly<S>,
): Kyoot<A, Simplify<Merge<S, { async: true; abort: TimeoutError }>>> {
  const TIMEOUT: unique symbol = Symbol("kyoot.timeout");
  return asyncOp(
    {
      execute: (rt) =>
        Promise.race([
          rt.spawn(k as AnyKyoot).promise,
          new Promise<typeof TIMEOUT>((resolve) => setTimeout(resolve, ms, TIMEOUT)),
        ]),
    },
    (r) => (r === TIMEOUT ? (abortFail(new TimeoutError(ms)) as AnyKyoot) : succeed(r)),
  ) as Kyoot<A, Simplify<Merge<S, { async: true; abort: TimeoutError }>>>;
}
