import { InterruptedError, op, succeed } from "../core.ts";
import { fail } from "./fail.ts";
import { sleep } from "./clock.ts";
import { Result } from "../result.ts";
import type { Kyoot } from "../model.ts";
import type { AsyncOp, AsyncRuntime, FiberHandle } from "../runtime.ts";
import type { Only, Row } from "../types.ts";

const asyncOp = <A>(execute: (rt: AsyncRuntime) => Promise<A>) =>
  op<A>()("async", { execute } as AsyncOp);

export const fromPromise = <A>(f: (signal: AbortSignal) => Promise<A>) =>
  asyncOp((rt) => f(rt.signal));

export const never = fromPromise<never>(() => new Promise(() => {}));

export interface Fiber<A> {
  readonly join: Kyoot<A, { async: AsyncOp }>;
  readonly await: Kyoot<Result<unknown, A>, { async: AsyncOp }>;
  readonly interrupt: Kyoot<void, { async: AsyncOp }>;
}

const fiber = <A>(h: FiberHandle<A>): Fiber<A> => ({
  join: asyncOp(() => h.promise),
  await: asyncOp(() =>
    h.promise.then(Result.ok, (e) =>
      e instanceof InterruptedError ? Result.interrupted() : Result.defect(e),
    ),
  ),
  interrupt: asyncOp(async () => h.interrupt()),
});

type Forkable<A, S extends Row> = Kyoot<A, S> & Only<S, "async" | "clock">;

const settle = (fibers: ReadonlyArray<FiberHandle>) =>
  Promise.allSettled(fibers.map((f) => (f.interrupt(), f.promise)));

export const fork = <A, S extends Row>(k: Forkable<A, S>) =>
  asyncOp((rt) => Promise.resolve(fiber(rt.spawn(k))));

export const race = <A, B, S1 extends Row, S2 extends Row>(
  a: Forkable<A, S1>,
  b: Forkable<B, S2>,
) =>
  asyncOp<A | B>((rt) => {
    const fibers = [rt.spawn(a), rt.spawn(b)];
    return Promise.race(fibers.map((f) => f.promise)).finally(() => settle(fibers));
  });

export const all = <A, S extends Row>(
  ks: ReadonlyArray<Forkable<A, S>>,
  options: { readonly concurrency?: number } = {},
) =>
  asyncOp(async (rt) => {
    const results: A[] = new Array(ks.length);
    const fibers: FiberHandle[] = [];
    let next = 0;
    let failed = false;
    const worker = async () => {
      while (!failed && next < ks.length) {
        const i = next++;
        const f = rt.spawn(ks[i]!);
        fibers.push(f);
        try {
          results[i] = await f.promise;
        } catch (e) {
          failed = true;
          throw e;
        }
      }
    };
    const workers = Math.max(1, Math.min(options.concurrency ?? Infinity, ks.length));
    try {
      await Promise.all(Array.from({ length: workers }, worker));
      return results;
    } finally {
      await settle(fibers);
    }
  });

export class TimeoutError extends Error {
  readonly _tag = "TimeoutError";
  readonly ms: number;
  constructor(ms: number) {
    super(`timed out after ${ms}ms`);
    this.name = "TimeoutError";
    this.ms = ms;
  }
}

class Timeout {
  readonly _tag = "Timeout";
}

export const timeout = <A, S extends Row>(ms: number, k: Forkable<A, S>) =>
  race(
    k,
    sleep(ms).map(() => new Timeout()),
  ).map((r) => (r instanceof Timeout ? fail(new TimeoutError(ms)) : succeed(r)));
