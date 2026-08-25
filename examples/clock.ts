import { Async, effect, Kyoot, makeHandler } from "../src/index.ts";
import type { Row } from "../src/index.ts";

export const Clock = effect<number, void>()("clock");
export const sleep = Clock;

export const liveClock = Clock.handle({
  onOp: (ms, resume) => Async.sleep(ms).map(() => resume(undefined)),
});

export const testClock = <A, S extends Row & { clock?: number }>(k: Kyoot<A, S>) =>
  makeHandler({
    effectKey: Clock.key,
    self: k,
    state: 0,
    onOp: (ms, resume, now) => resume(undefined, now + ms),
    onSuccess: (a, now) => Kyoot.succeed([a, now] as const),
  });

const boilEgg = (minute: number) =>
  Kyoot.gen(function* () {
    console.log("  water on");
    yield* sleep(1 * minute);
    console.log("  boiling, egg in");
    yield* sleep(6 * minute);
    return "egg ready";
  });

if (process.argv[1]?.endsWith("clock.ts")) {
  const [result, elapsedMs] = Kyoot.runSync(boilEgg(60_000).pipe(testClock));
  console.log(`${result} — ${elapsedMs / 60_000} virtual minutes, zero real ones\n`);

  console.log("same program, live clock, 20ms minutes:");
  const t0 = Date.now();
  const real = await Kyoot.runPromise(boilEgg(20).pipe(liveClock));
  console.log(`${real} — ${Date.now() - t0}ms real time`);
}
