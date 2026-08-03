import { Async, effect, Kyoot, succeed } from "../src/index.ts";
import type { AnyKyoot, Merge, Row, Simplify } from "../src/index.ts";

const Clock = effect<"clock", number>("clock");

export const sleep = (ms: number) => Clock.op<void>(ms);

const live = Clock.handle({
  onOp: (ms, resume) => Async.sleep(ms).map(() => resume(undefined)),
  onSuccess: (a) => succeed(a),
});

export const liveClock = <A, S extends Row & { clock?: number } = {}>(
  k: Kyoot<A, S>,
): Kyoot<A, Simplify<Merge<Omit<S, "clock">, { async: true }>>> =>
  live(k as AnyKyoot) as Kyoot<A, Simplify<Merge<Omit<S, "clock">, { async: true }>>>;

const virtual = Clock.handle<number>({
  state: 0,
  onOp: (ms, resume, now) => resume(undefined, now + ms),
  onSuccess: (a, now) => succeed([a, now] as const),
});

export const testClock = <A, S extends Row & { clock?: number } = {}>(k: Kyoot<A, S>) =>
  virtual<A, S, readonly [A, number]>(k);

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
