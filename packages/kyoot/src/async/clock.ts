import { effect, gen, makeOp } from "../core.ts";
import type { Kyoot } from "../model.ts";
import type { AsyncRuntime } from "./runtime.ts";
import type { MergeAll, Op, Row } from "../types.ts";

const clock = effect<number, void>()("clock");

export const sleep = (ms: number) => clock(ms);

export const handle = clock.handle;

export const handleWith = clock.handleWith;

export const intercept = clock.intercept;

export const virtual = <A, S extends Row & { clock?: Op<number, void> }>(
  k: Kyoot<A, S>,
): Kyoot<readonly [A, number], MergeAll<Omit<S, "clock">>> =>
  gen(function* () {
    let now = 0;
    const a = yield* k.pipe(
      clock.handle((ms, resume) => {
        now += ms;
        return resume(undefined);
      }),
    );
    return [a, now] as const;
  }) as never;

const realSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const onAbort = () => clearTimeout(t);
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

export const live = clock.handle((ms, resume) =>
  resume.with(
    makeOp("async", { execute: (rt: AsyncRuntime) => realSleep(ms, rt.signal) }) as never,
  ),
);
