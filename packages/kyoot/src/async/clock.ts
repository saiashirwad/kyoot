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

export interface TestClock {
  readonly now: number;
  readonly handler: typeof live;
  advance(ms: number): Promise<void>;
}

const flush = () =>
  new Promise<void>((r) =>
    typeof setImmediate === "function" ? setImmediate(r) : setTimeout(r, 0),
  );

// A clock whose time moves only by advance(). State lives in the returned object, so one clock can be
// installed in the parent and in every fork (via `provide`). Sleeps park until time reaches them.
export const test = (): TestClock => {
  let now = 0;
  const sleepers = new Set<{ readonly at: number; readonly wake: () => void }>();
  const sleepUntil = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const s = { at: now + ms, wake: resolve };
      sleepers.add(s);
      signal.addEventListener("abort", () => sleepers.delete(s), { once: true });
    });
  const due = (target: number) =>
    [...sleepers].filter((s) => s.at <= target).sort((a, b) => a.at - b.at)[0];
  return {
    get now() {
      return now;
    },
    handler: clock.handle((ms, resume) =>
      resume.with(
        makeOp("async", { execute: (rt: AsyncRuntime) => sleepUntil(ms, rt.signal) }) as never,
      ),
    ),
    // Wakes sleepers in deadline order, letting woken fibers run (and sleep again) before moving on.
    async advance(ms) {
      const target = now + ms;
      await flush();
      for (let s = due(target); s !== undefined; s = due(target)) {
        sleepers.delete(s);
        now = Math.max(now, s.at);
        s.wake();
        await flush();
      }
      now = target;
    },
  };
};

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
