import { answering, effect, gen } from "../core.ts";
import type { Kyoot } from "../model.ts";
import type { MergeAll, Op, Row } from "../types.ts";
import { fromPromise, type AsyncRow } from "./promise.ts";

// Time is two data effects, clock/sleep and clock/now. runPromise answers them with real timers and
// Sim.run with virtual time, so most programs need no clock handler at all. The handlers below
// replace the driver's answer for one subtree.
const sleeping = effect<number, void>()("clock/sleep");

export { now, sleep } from "./effects.ts";

export type ClockRow = { "clock/sleep": Op<number, void>; "clock/now": Op<void, number> };

type ClockKey = keyof ClockRow;

type Handled<A, S extends Row, R extends Row = {}> = Kyoot<A, MergeAll<Omit<S, ClockKey> | R>>;

export const handle = sleeping.handle;

export const handleWith = sleeping.handleWith;

export const intercept = sleeping.intercept;

// Sleeps finish at once and add up; answers [value, elapsed].
export const virtual = <A, S extends Row & Partial<ClockRow>>(
  k: Kyoot<A, S>,
): Handled<readonly [A, number], S> =>
  gen(function* () {
    let now = 0;
    const a = yield* k.pipe(
      sleeping.handle((ms, resume) => {
        now += ms;
        return resume(undefined);
      }),
      answering("clock/now", () => now),
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

// Real time through promise interop. runPromise already sleeps for real; use this to put real time
// back inside a subtree whose clock an outer handler would otherwise answer.
export const live = <A, S extends Row & Partial<ClockRow>>(
  k: Kyoot<A, S>,
): Handled<A, S, AsyncRow> =>
  k.pipe(
    sleeping.handle((ms, resume) =>
      resume.with(fromPromise((signal) => realSleep(ms, signal)) as never),
    ),
    answering("clock/now", () => Date.now()),
  ) as never;

export interface ManualClock {
  readonly now: number;
  readonly handler: typeof live;
  advance(ms: number): Promise<void>;
}

const flush = () =>
  new Promise<void>((r) =>
    typeof setImmediate === "function" ? setImmediate(r) : setTimeout(r, 0),
  );

// A clock whose time moves only by advance(). State lives in the returned object, so one clock can be
// installed in the parent and in every fork (Async.provide, or fork's provide). Sleeps park until
// time reaches them.
export const manual = (): ManualClock => {
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
    handler: (k) =>
      k.pipe(
        sleeping.handle((ms, resume) =>
          resume.with(fromPromise((signal) => sleepUntil(ms, signal)) as never),
        ),
        answering("clock/now", () => now),
      ) as never,
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
