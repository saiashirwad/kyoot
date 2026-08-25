import { Async, effect, Kyoot, makeHandler } from "../src/index.ts";
import type { Row } from "../src/index.ts";

export const Clock = effect<number, void>()("clock");
export const sleep = Clock;

export const liveClock = Clock.handle({
  onOp: (ms, resume) => Async.sleep(ms).map(() => resume(undefined)),
});

export const testClock = <A, S extends Row & { clock?: number }>(k: Kyoot<A, S>) =>
  makeHandler(Clock.key, k, {
    initial: 0,
    onOp: (ms, resume, now) => resume(undefined, now + ms),
    onSuccess: (a, now) => Kyoot.succeed([a, now] as const),
  });

export const boilEgg = (minute: number) =>
  Kyoot.gen(function* () {
    yield* sleep(1 * minute);
    yield* sleep(6 * minute);
    return "egg ready";
  });
