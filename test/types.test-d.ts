import { Async, Emit, Env, Fail, Kyoot, makeOp, Sync, Var } from "../src/index.ts";
import type { Kyoot as KyootT, Result, RowsOf } from "../src/index.ts";
import { sleep, testClock } from "../examples/clock.ts";

type Expect<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

class FetchFailed {
  readonly _tag = "FetchFailed";
}

interface Greeter {
  greet(name: string): string;
}
class Greeter extends Env.Tag<Greeter>()("greeter") {}

class Total extends Var.Tag<number>()("Total") {}

const mixed = Kyoot.gen(function* () {
  yield* Fail.fail(new FetchFailed());
  yield* Async.sleep(1);
  yield* Sync.defer(() => 1);
  return "done";
});
type MixedRows = RowsOf<typeof mixed>;
type _mixedKeys = Expect<Equal<keyof MixedRows, "fail" | "async" | "sync">>;
type _mixedFail = Expect<Equal<MixedRows["fail"], FetchFailed>>;
type _mixedAsync = Expect<Equal<MixedRows["async"], true>>;
type _mixedValue = Expect<Equal<typeof mixed extends KyootT<infer A, any> ? A : never, string>>;

// @ts-expect-error runSync rejects async rows
Kyoot.runSync(Async.sleep(1));

// @ts-expect-error runSync names every unhandled key: Unhandled<"fail" | "async" | "sync">
Kyoot.runSync(mixed);

const syncProg = Sync.defer(() => 1);
// @ts-expect-error runSync requires an empty row
Kyoot.runSync(syncProg);
const s1: number = Kyoot.runSync(syncProg.pipe(Sync.run()));

const p1: Promise<number> = Kyoot.runPromise(Async.fromPromise(() => Promise.resolve(1)));

// @ts-expect-error runPromise rejects rows the driver cannot satisfy
Kyoot.runPromise(Fail.fail(new FetchFailed()));

const fp = Async.fromPromise((signal) => fetch("https://example.com", { signal }));
type _fpKeys = Expect<Equal<keyof RowsOf<typeof fp>, "async">>;
type _fpValue = Expect<Equal<typeof fp extends KyootT<infer A, any> ? A : never, Response>>;

const timed = Async.timeout(100, Async.sleep(1));
type _timedKeys = Expect<Equal<keyof RowsOf<typeof timed>, "async" | "fail">>;
type _timedFail = Expect<Equal<RowsOf<typeof timed>["fail"], Async.TimeoutError>>;

const greeted = Kyoot.gen(function* () {
  const g = yield* Greeter;
  return g.greet("kyoot");
}).pipe(Greeter.provide({ greet: (n) => `hi ${n}` }));
const g1: string = Kyoot.runSync(greeted);
// @ts-expect-error provide returns A, not a tuple
const g2: [string, Greeter] = Kyoot.runSync(greeted);

const handled = Kyoot.gen(function* () {
  yield* Fail.fail(new FetchFailed());
  return 1;
}).pipe(Fail.run());
const f1: Result<FetchFailed, number> = Kyoot.runSync(handled);

const counted = Kyoot.gen(function* () {
  yield* Total.update((t) => t + 1);
  return yield* Total.get();
}).pipe(Total.run(0));
const v1: [number, number] = Kyoot.runSync(counted);

const emitted = Kyoot.gen(function* () {
  yield* Emit.value("a");
  return 1;
}).pipe(Emit.run());
const e1: [number, string[]] = Kyoot.runSync(emitted);

const logOp = makeOp("log", "hello") as KyootT<void, { log: string }>;
type _logKeys = Expect<Equal<keyof RowsOf<typeof logOp>, "log">>;
// @ts-expect-error runSync names the unhandled custom effect: Unhandled<"log">
Kyoot.runSync(logOp);

const clockProg = sleep(5).pipe(testClock);
const c1: readonly [void, number] = Kyoot.runSync(clockProg);
