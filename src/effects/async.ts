import { makeOp, succeed } from "../core.ts";
import { fail as abortFail } from "./abort.ts";
import { Result } from "../result.ts";
import type { AnyKyoot, Kyoot } from "../model.ts";
import type { AsyncOp } from "../runtime.ts";
import type { AsyncOnly, Merge, Row, Simplify } from "../types.ts";

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

export type FiberState = "running" | "done" | "interrupted";

export interface Fiber<A> {
  readonly state: FiberState;
  readonly join: Kyoot<A, { async: true }>;
  readonly await: Kyoot<Result<unknown, A>, { async: true }>;
}

class FiberImpl<A> implements Fiber<A> {
  state: FiberState = "running";

  readonly promise: Promise<A>;

  constructor(promise: Promise<A>) {
    this.promise = promise;
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

export function fork<A, S extends Row>(
  k: Kyoot<A, S> & AsyncOnly<S>,
): Kyoot<Fiber<A>, Simplify<Merge<S, { async: true }>>> {
  return asyncOp({
    execute: (rt) => Promise.resolve(new FiberImpl(rt.spawn(k as AnyKyoot).promise as Promise<A>)),
  }) as Kyoot<Fiber<A>, Simplify<Merge<S, { async: true }>>>;
}

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
