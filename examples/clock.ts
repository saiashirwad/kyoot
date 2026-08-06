import { Async, Kyoot, KyootImpl, makeOp, succeed } from "../src/index.ts";
import type { AnyKyoot, Merge, Row, Simplify } from "../src/index.ts";

export const sleep = (ms: number): Kyoot<void, { clock: number }> =>
  makeOp("clock", ms) as Kyoot<void, { clock: number }>;

export const liveClock = <A, S extends Row & { clock?: number } = {}>(k: Kyoot<A, S>) =>
  new KyootImpl({
    _tag: "handler",
    effectKey: "clock",
    self: k as AnyKyoot,
    onOp: (ms: number, resume) => Async.sleep(ms).map(() => resume(undefined)),
    onSuccess: (a) => succeed(a),
  });

export const testClock = <A, S extends Row & { clock?: number } = {}>(k: Kyoot<A, S>) =>
  new KyootImpl({
    _tag: "handler",
    effectKey: "clock",
    self: k as AnyKyoot,
    state: 0,
    onOp: (ms: number, resume, now: number) => resume(undefined, now + ms),
    onSuccess: (a, now) => succeed([a, now] as const),
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
