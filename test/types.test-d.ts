import { Async, Emit, Env, Fail, Kyoot, op, Sync, Var, makeHandler } from "../src/index.ts";
import type { AsyncOp, Kyoot as KyootT, Result, RowsOf } from "../src/index.ts";
import { sleep, testClock } from "../examples/clock.ts";

type Expect<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

class FetchFailed {
  readonly _tag = "FetchFailed";
}

interface Greeter {
  greet(name: string): string;
}
const Greeter = Env.tag<Greeter>()("greeter");

const Total = Var.tag<number>()("Total");

const mixed = Kyoot.gen(function* () {
  yield* Fail.fail(new FetchFailed());
  yield* Async.sleep(1);
  yield* Sync.defer(() => 1);
  return "done";
});
type MixedRows = RowsOf<typeof mixed>;
type _mixedKeys = Expect<Equal<keyof MixedRows, "fail" | "async" | "sync">>;
type _mixedFail = Expect<Equal<MixedRows["fail"], FetchFailed>>;
// the row value is the op's payload type
type _mixedAsync = Expect<Equal<MixedRows["async"], AsyncOp>>;
type _mixedSync = Expect<Equal<MixedRows["sync"], () => unknown>>;
type _mixedValue = Expect<Equal<typeof mixed extends KyootT<infer A, any> ? A : never, string>>;

// @ts-expect-error runSync rejects async rows
Kyoot.runSync(Async.sleep(1));

// @ts-expect-error runSync names every unhandled key: Unhandled<"fail" | "async" | "sync">
Kyoot.runSync(mixed);

const syncProg = Sync.defer(() => 1);
// @ts-expect-error runSync requires an empty row
Kyoot.runSync(syncProg);
const s1: number = Kyoot.runSync(syncProg.pipe(Sync.run));

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
}).pipe(Fail.run);
const f1: Result<FetchFailed, number> = Kyoot.runSync(handled);

const counted = Kyoot.gen(function* () {
  yield* Total.update((t) => t + 1);
  return yield* Total.get();
}).pipe(Total.run(0));
const v1: readonly [number, number] = Kyoot.runSync(counted);

const emitted = Kyoot.gen(function* () {
  yield* Emit.value("a");
  return 1;
}).pipe(Emit.run);
const e1: readonly [number, string[]] = Kyoot.runSync(emitted);

const logOp = op<void>()("log", "hello");
type _logKeys = Expect<Equal<keyof RowsOf<typeof logOp>, "log">>;
type _logPayload = Expect<Equal<RowsOf<typeof logOp>["log"], string>>;
// @ts-expect-error runSync names the unhandled custom effect: Unhandled<"log">
Kyoot.runSync(logOp);

const clockProg = sleep(5).pipe(testClock);
const c1: readonly [void, number] = Kyoot.runSync(clockProg);

// pure map (including throw → never) must keep the effect row; no Row pollution
const pureMapped = Async.sleep(1).map((_) => 1);
type _pureMapKeys = Expect<Equal<keyof RowsOf<typeof pureMapped>, "async">>;
type _pureMapValue = Expect<
  Equal<typeof pureMapped extends KyootT<infer A, any> ? A : never, number>
>;

const neverMapped = Async.sleep(1).map(() => {
  throw new Error("boom");
});
type _neverMapKeys = Expect<Equal<keyof RowsOf<typeof neverMapped>, "async">>;
// fork accepts a pure-mapped body (Only<"async">, not a widened Row)
const forked = Async.fork(neverMapped);
type _forkKeys = Expect<Equal<keyof RowsOf<typeof forked>, "async">>;

// nested Kyoot from map still flattens and merges rows
const flatMapped = Kyoot.succeed(1).map((n) => Fail.fail(String(n)));
type _flatKeys = Expect<Equal<keyof RowsOf<typeof flatMapped>, "fail">>;
type _flatFail = Expect<Equal<RowsOf<typeof flatMapped>["fail"], string>>;

// ---------------------------------------------------------------------------
// Handler result types are inferred by makeHandler, not annotated.
// ---------------------------------------------------------------------------
import type { DefectCause, Err, FailCause, Ok } from "../src/index.ts";
type ValueOf<K> = K extends KyootT<infer A, any> ? A : never;

// Fail.run: a union of the branches its callbacks build — which is a Result.
type _failRunValue = Expect<
  Equal<ValueOf<typeof handled>, Ok<number> | Err<FailCause<FetchFailed>> | Err<DefectCause>>
>;
type _failRunKeys = Expect<Equal<keyof RowsOf<typeof handled>, never>>;

// catchAll: the recovery's value and row join the result.
const recovered = Kyoot.gen(function* () {
  yield* Fail.fail(new FetchFailed());
  return 1;
}).pipe(Fail.catchAll(() => Async.sleep(1).map(() => "fallback" as const)));
type _catchAllValue = Expect<Equal<ValueOf<typeof recovered>, number | "fallback">>;
type _catchAllKeys = Expect<Equal<keyof RowsOf<typeof recovered>, "async">>;

// A handler whose onOp runs an async op adds `async` to the row.
const slowSync = Sync.defer(() => 1).pipe((k) =>
  makeHandler({
    effectKey: "sync",
    self: k,
    onOp: (f, resume) => Async.sleep(1).map(() => resume(f())), // f: () => unknown, from the row
  }),
);
type _asyncHandlerValue = Expect<Equal<ValueOf<typeof slowSync>, number>>;
type _asyncHandlerKeys = Expect<Equal<keyof RowsOf<typeof slowSync>, "async">>;
