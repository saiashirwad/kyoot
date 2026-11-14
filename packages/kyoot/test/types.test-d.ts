import { answerAll, effect, ensuring, handleAll, Kyoot } from "../src/index.ts";
import * as Emit from "../src/effects/emit.ts";
import * as Env from "../src/effects/env.ts";
import * as Fail from "../src/effects/fail.ts";
import * as Resource from "../src/effects/resource.ts";
import * as Sync from "../src/effects/sync.ts";
import * as Var from "../src/effects/var.ts";
import type { Kyoot as KyootT, Op, Payload, Resume, RowsOf } from "../src/index.ts";
import { op } from "../src/core.ts";

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
  yield* Async.fromPromise(() => Promise.resolve(1));
  yield* Clock.sleep(1);
  yield* Sync.defer(() => 1);
  return "done";
});
type MixedRows = RowsOf<typeof mixed>;
type _mixedKeys = Expect<Equal<keyof MixedRows, "fail" | "async" | "clock/sleep" | "sync">>;
type _mixedFail = Expect<Equal<MixedRows["fail"], Op<FetchFailed, never>>>;
type _mixedAsync = Expect<Equal<MixedRows["async"], Op<AsyncOp, unknown>>>;
type _mixedSync = Expect<Equal<MixedRows["sync"], Op<() => unknown, unknown>>>;
type _mixedClock = Expect<Equal<MixedRows["clock/sleep"], Op<number, void>>>;
type _mixedValue = Expect<Equal<typeof mixed extends KyootT<infer A, any> ? A : never, string>>;

// @ts-expect-error runSync rejects clock rows
Kyoot.runSync(Clock.sleep(1));
// runPromise answers clock/sleep itself; Clock.live turns it into promise interop.
const sleptLive: Promise<void> = runPromise(Clock.sleep(1));
const slept: Promise<void> = runPromise(Clock.sleep(1).pipe(Clock.live));

// @ts-expect-error runSync names every unhandled key: Unhandled<"fail" | "async" | "clock/sleep" | "sync">
Kyoot.runSync(mixed);

const syncProg = Sync.defer(() => 1);
// @ts-expect-error runSync requires an empty row
Kyoot.runSync(syncProg);
const s1: number = Kyoot.runSync(syncProg.pipe(Sync.run));

const p1: Promise<number> = runPromise(Async.fromPromise(() => Promise.resolve(1)));

// @ts-expect-error runPromise rejects rows the driver cannot satisfy
runPromise(Fail.fail(new FetchFailed()));

const fp = Async.fromPromise((signal) => fetch("https://example.com", { signal }));
type _fpKeys = Expect<Equal<keyof RowsOf<typeof fp>, "async">>;
type _fpValue = Expect<Equal<typeof fp extends KyootT<infer A, any> ? A : never, Response>>;

const batched = Kyoot.gen(function* () {
  const doubled = yield* Async.mapPromise([1, 2, 3], (n) => Promise.resolve(n * 2));
  yield* Async.forEachPromise(doubled, (n) => Promise.resolve(n));
  return yield* Async.reducePromise(doubled, "", (acc, n) => Promise.resolve(`${acc}${n}`));
});
type _batchedKeys = Expect<Equal<keyof RowsOf<typeof batched>, "async">>;
type _batchedValue = Expect<Equal<typeof batched extends KyootT<infer A, any> ? A : never, string>>;

const timed = Async.timeout(100, Clock.sleep(1).pipe(Clock.live));
type Spawning = "fiber/fork" | "fiber/join" | "fiber/interrupt";
type _timedKeys = Expect<
  Equal<keyof RowsOf<typeof timed>, Spawning | "clock/sleep" | "async" | "fail">
>;
type _timedFail = Expect<Equal<Payload<RowsOf<typeof timed>, "fail">, Async.Timeout>>;

const testClock = Clock.manual();
const timedTest = Async.timeout(100, Clock.sleep(1), { provide: (k) => k.pipe(testClock.handler) });
type _timedTestKeys = Expect<Equal<keyof RowsOf<typeof timedTest>, Spawning | "async" | "fail">>;
// Without a clock in provide, the driver answers the sleep: it stays in the row.
const timedPlain = Async.timeout(100, Clock.sleep(1), { provide: (k) => k });
type _timedPlainKeys = Expect<
  Equal<keyof RowsOf<typeof timedPlain>, Spawning | "clock/sleep" | "fail">
>;

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
const f1: Fail.Result<FetchFailed, number> = Kyoot.runSync(handled);

const counted = Kyoot.gen(function* () {
  yield* Total.update((t) => t + 1);
  return yield* Total.get();
}).pipe(Total.run(0));
const v1: readonly [number, number] = Kyoot.runSync(counted);

const emitted = Kyoot.gen(function* () {
  yield* Emit.value("a");
  return 1;
}).pipe(Emit.collect);
const e1: readonly [number, string[]] = Kyoot.runSync(emitted);

const logOp = op<void>()("log", "hello");
type _logKeys = Expect<Equal<keyof RowsOf<typeof logOp>, "log">>;
type _logPayload = Expect<Equal<RowsOf<typeof logOp>["log"], Op<string, void>>>;
// @ts-expect-error runSync names the unhandled custom effect: Unhandled<"log">
Kyoot.runSync(logOp);

const Ask = effect<{ q: string }, number>()("ask");
const asked = Ask({ q: "n?" }).map((n) => n + 1);
type _askRow = Expect<Equal<RowsOf<typeof asked>, { ask: Op<{ q: string }, number> }>>;
const answered: number = asked.pipe(
  Ask.handle(({ q }, resume) => resume(q.length)),
  Kyoot.runSync,
);
// @ts-expect-error resume is typed to the answer
Ask.handle((_p, resume) => resume("no"));
// @ts-expect-error the payload is typed by the declaration
Ask.handle(({ nope }, resume) => resume(1));
const refused = asked.pipe(Ask.handle(() => Fail.fail("refused" as const)));
type _refusedRow = Expect<Equal<keyof RowsOf<typeof refused>, "fail">>;
const cached = asked.pipe(Ask.handle(() => Kyoot.succeed("cached" as const)));
type _cachedValue = Expect<Equal<ValueOf<typeof cached>, number | "cached">>;

const clockProg = Clock.sleep(5).pipe(Clock.virtual);
const c1: readonly [void, number] = Kyoot.runSync(clockProg);

const retried = Kyoot.gen(function* () {
  yield* Fail.fail(new FetchFailed());
  return 1;
}).pipe(Retry.retry({ times: 3, delay: 10 }));
type _retryKeys = Expect<Equal<keyof RowsOf<typeof retried>, "fail" | "clock/sleep">>;
type _retryFail = Expect<Equal<Payload<RowsOf<typeof retried>, "fail">, FetchFailed>>;
type _retryValue = Expect<Equal<ValueOf<typeof retried>, number>>;

const pureMapped = Async.fromPromise(() => Promise.resolve()).map((_) => 1);
type _pureMapKeys = Expect<Equal<keyof RowsOf<typeof pureMapped>, "async">>;
type _pureMapValue = Expect<
  Equal<typeof pureMapped extends KyootT<infer A, any> ? A : never, number>
>;

const neverMapped = Async.fromPromise(() => Promise.resolve()).map(() => {
  throw new Error("boom");
});
type _neverMapKeys = Expect<Equal<keyof RowsOf<typeof neverMapped>, "async">>;
const forked = Async.fork(neverMapped);
type _forkKeys = Expect<Equal<keyof RowsOf<typeof forked>, "fiber/fork" | "async">>;

const flatMapped = Kyoot.succeed(1).flatMap((n) => Fail.fail(String(n)));
type _flatKeys = Expect<Equal<keyof RowsOf<typeof flatMapped>, "fail">>;
type _flatFail = Expect<Equal<RowsOf<typeof flatMapped>["fail"], Op<string, never>>>;

import { Async, Clock, Retry, runPromise } from "../src/async/index.ts";
import type { AsyncOp, Exit } from "../src/async/index.ts";
type ValueOf<K> = K extends KyootT<infer A, any> ? A : never;

type _failRunValue = Expect<
  Equal<
    ValueOf<typeof handled>,
    Fail.Ok<number> | Fail.Err<Fail.FailCause<FetchFailed>> | Fail.Err<Fail.DefectCause>
  >
>;
type _failRunKeys = Expect<Equal<keyof RowsOf<typeof handled>, never>>;

const recovered = Kyoot.gen(function* () {
  yield* Fail.fail(new FetchFailed());
  return 1;
}).pipe(Fail.catchAll(() => Clock.sleep(1).map(() => "fallback" as const)));
type _catchAllValue = Expect<Equal<ValueOf<typeof recovered>, number | "fallback">>;
type _catchAllKeys = Expect<Equal<keyof RowsOf<typeof recovered>, "clock/sleep">>;

const slowSync = Sync.defer(() => 1).pipe((k) =>
  ensuring(
    k.pipe(Sync.handle((f, resume) => Clock.sleep(1).flatMap(() => resume(f())))),
    Async.fromPromise(() => Promise.resolve()),
  ),
);
type _asyncHandlerValue = Expect<Equal<ValueOf<typeof slowSync>, number>>;
type _asyncHandlerKeys = Expect<Equal<keyof RowsOf<typeof slowSync>, "async" | "clock/sleep">>;

class Tagged1 {
  readonly _tag = "One";
}
class Tagged2 {
  readonly _tag = "Two";
}
declare const flag: boolean;
const twoFails = Kyoot.gen(function* () {
  if (flag) yield* Fail.fail(new Tagged1());
  yield* Fail.fail(new Tagged2());
  return 1;
});
const oneLeft = twoFails.pipe(Fail.catchTag("One", () => Kyoot.succeed("r" as const)));
type _oneLeftFail = Expect<Equal<RowsOf<typeof oneLeft>["fail"], Op<Tagged2, never>>>;
type _oneLeftValue = Expect<Equal<ValueOf<typeof oneLeft>, number | "r">>;
const noneLeft = oneLeft.pipe(Fail.catchTag("Two", () => Kyoot.succeed(0)));
type _noneLeftKeys = Expect<Equal<keyof RowsOf<typeof noneLeft>, never>>;

const tokens = Emit.fromIterable(["a", "b"]);
type _tokensRow = Expect<Equal<RowsOf<typeof tokens>, { emit: Op<string, void> }>>;
const mapped = tokens.pipe(Emit.map((t: string) => t.length));
type _mappedEmit = Expect<Equal<RowsOf<typeof mapped>["emit"], Op<number, void>>>;
const consumed = mapped.pipe(Emit.forEach((n: number) => Clock.sleep(n)));
type _consumedKeys = Expect<Equal<keyof RowsOf<typeof consumed>, "clock/sleep">>;
const iter: AsyncIterable<number> = Async.toAsyncIterable(mapped);

const scoped = Resource.acquire(
  () => 1,
  () => Clock.sleep(1),
).pipe(Resource.run);
type _scopedKeys = Expect<Equal<keyof RowsOf<typeof scoped>, "clock/sleep">>;
const plainScoped = Resource.acquire(
  () => 1,
  () => {},
).pipe(Resource.run);
type _plainScopedKeys = Expect<Equal<keyof RowsOf<typeof plainScoped>, never>>;

const needsGreeter = Kyoot.gen(function* () {
  const g = yield* Greeter;
  if (g.greet("x") === "") yield* Fail.fail(new FetchFailed());
  yield* Clock.sleep(1);
  return 1;
});
// A fork leaves what its program doesn't handle (but its failure) in the parent's row: the driver
// must answer it for every fiber, so runPromise still asks for a greeter handler.
const forkedNeedy = Async.fork(needsGreeter);
type _needyKeys = Expect<
  Equal<
    keyof RowsOf<typeof forkedNeedy>,
    "fiber/fork" | "env/greeter" | "fork/env/greeter" | "clock/sleep"
  >
>;
// @ts-expect-error runPromise names what no handler answers: Unhandled<"env/greeter">
runPromise(forkedNeedy);
// Async.provide installs it in the program and in every fiber it forks.
const providedNeedy = forkedNeedy.pipe(Async.provide(Greeter.provide({ greet: (n) => n })));
type _providedNeedyKeys = Expect<
  Equal<keyof RowsOf<typeof providedNeedy>, "fiber/fork" | "clock/sleep">
>;

const ready = needsGreeter.pipe(Greeter.provide({ greet: (n) => n }), Clock.live);
const forkedReady = Async.fork(ready);
type _forkReadyKeys = Expect<Equal<keyof RowsOf<typeof forkedReady>, "fiber/fork" | "async">>;
declare const needy: ValueOf<typeof forkedReady>;
const needyJoin = Async.join(needy);
type _joinKeys = Expect<
  Equal<keyof RowsOf<typeof needyJoin>, "fiber/join" | "fiber/interrupt" | "fail">
>;
type _joinFail = Expect<Equal<Payload<RowsOf<typeof needyJoin>, "fail">, FetchFailed>>;
type _joinValue = Expect<Equal<ValueOf<typeof needyJoin>, number>>;
type _awaitValue = Expect<
  Equal<ValueOf<ReturnType<typeof Async.wait<number, FetchFailed>>>, Exit<FetchFailed, number>>
>;

declare const pure: ValueOf<typeof forked>;
const pureJoin = Async.join(pure);
type _pureJoinKeys = Expect<Equal<keyof RowsOf<typeof pureJoin>, "fiber/join" | "fiber/interrupt">>;

const joined = Kyoot.gen(function* () {
  const fiber = yield* Async.fork(ready);
  return yield* Async.join(fiber);
}).pipe(Fail.run);
const j1: Promise<Fail.Result<FetchFailed, number>> = runPromise(joined);

const raced = Async.race(ready, Fail.fail("other" as const));
type _raceKeys = Expect<Equal<keyof RowsOf<typeof raced>, Spawning | "async" | "fail">>;
type _raceFail = Expect<Equal<RowsOf<typeof raced>["fail"], Op<FetchFailed | "other", never>>>;
const allOf = Async.all([ready, ready]);
type _allKeys = Expect<Equal<keyof RowsOf<typeof allOf>, Spawning | "async" | "fail">>;
type _allValue = Expect<Equal<ValueOf<typeof allOf>, number[]>>;
const none = Async.all([]);
type _noneKeys = Expect<Equal<keyof RowsOf<typeof none>, Spawning>>;

const Config = Env.tag<{ url: string }>()("config");
const Db = Env.tag<{ query(sql: string): KyootT<string, { async: Op<AsyncOp, unknown> }> }>()("db");
const makeDb = Kyoot.gen(function* () {
  const { url } = yield* Config;
  yield* Resource.acquire(
    () => url,
    () => undefined,
  );
  return { query: (sql: string) => Async.fromPromise(async () => sql) };
});

const usesDb = Db.get().flatMap((db) => db.query("select 1"));
const provided = usesDb.pipe(Db.provide(makeDb));
type _providedRow = Expect<
  Equal<keyof RowsOf<typeof provided>, "async" | "env/config" | "resource">
>;
const wired = usesDb.pipe(Db.provide(makeDb), Config.provide({ url: "" }), Resource.run);
type _wiredRow = Expect<Equal<keyof RowsOf<typeof wired>, "async">>;
const backwards = usesDb.pipe(Config.provide({ url: "" }), Db.provide(makeDb));
type _backwardsRow = Expect<
  Equal<keyof RowsOf<typeof backwards>, "async" | "env/config" | "resource">
>;

class Declined {
  readonly _tag = "Declined";
}
const Pay = effect<number, string, { fail: Op<Declined, never> }>()("pay");
type _payRow = Expect<Equal<keyof RowsOf<ReturnType<typeof Pay>>, "pay" | "fail">>;
Pay.handle((_, resume) => resume.with(Fail.fail(new Declined())));
Pay.handle((_, resume) => resume.with(Kyoot.succeed("ok")));
// @ts-expect-error a failure outside the contract
Pay.handle((_, resume) => resume.with(Fail.fail("wrong type")));
// @ts-expect-error an effect the op site was not told about
Pay.handle((_, resume) => resume.with(Log.info("x").map(() => "ok")));
const Plain = effect<number, string>()("plain");
// @ts-expect-error no contract: nothing may be handed back but a value
Plain.handle((_, resume) => resume.with(Fail.fail(new Declined())));

const Recv = effect<{ readonly from: string }, number>()("recv");
const stepped = Kyoot.step(
  Kyoot.gen(function* () {
    yield* Fail.fail(new FetchFailed());
    return yield* Recv({ from: "inbox" });
  }),
);
if (!stepped.done) {
  type _stepKeys = Expect<Equal<typeof stepped.key, "recv" | "fail">>;
  // @ts-expect-error a step that may be a failure has no answer until its key is known
  stepped.resume(1);
  switch (stepped.key) {
    case "recv": {
      type _stepPayload = Expect<Equal<typeof stepped.payload, { readonly from: string }>>;
      type _stepAnswer = Expect<Equal<Parameters<typeof stepped.resume>[0], number>>;
      // @ts-expect-error resume is typed to the answer of the pending key
      stepped.resume("one");
      const after = stepped.resume(1);
      if (after.done) {
        type _stepValue = Expect<Equal<typeof after.value, number>>;
        // @ts-expect-error a finished step has nothing to resume
        after.resume(2);
      }
      break;
    }
    case "fail": {
      type _stepFail = Expect<Equal<typeof stepped.payload, FetchFailed>>;
      // @ts-expect-error a failure cannot be resumed
      stepped.resume(undefined);
      break;
    }
    default: {
      const _exhaustive: never = stepped;
    }
  }
  const cancelled = stepped.cancel();
  type _cancelValue = Expect<
    Equal<Extract<typeof cancelled, { readonly done: true }>["value"], undefined>
  >;
}

const askStep = Kyoot.step(asked);
if (!askStep.done) {
  type _askPayload = Expect<Equal<typeof askStep.payload, { q: string }>>;
  askStep.resume(1);
  // @ts-expect-error a pending ask is answered with a number
  askStep.resume("one");
}

const answeredRow = asked.pipe(Ask.handle(({ q }, resume) => resume(q.length)));
type _answeredRow = Expect<Equal<keyof RowsOf<typeof answeredRow>, never>>;
// @ts-expect-error handle types resume from the declaration
asked.pipe(Ask.handle((_p, resume) => resume("no")));

const Echo = effect<string, string>()("echo");
// @ts-expect-error annotated params must match the declaration (#50)
Echo.handle((_p: number, resume: Resume<number>) => resume(42));
// @ts-expect-error an annotated payload must match the declaration
Echo.handle((_p: number, resume) => resume("x"));
// @ts-expect-error an annotated resume must match the declaration
Echo.handle((_p, resume: Resume<number>) => resume(1));

// handleAll / answerAll check each handler against its own declaration.
const Peek = effect<void, number>()("peek");
const Poke2 = effect<string, void>()("poke2");
const group = { peek: Peek, poke: Poke2 };
const both = Kyoot.gen(function* () {
  yield* Poke2("x");
  return yield* Peek(undefined);
});
const grouped = both.pipe(
  handleAll(group, {
    peek: (_, resume) => resume(1),
    poke: (s, resume) => resume(s.length === 0 ? undefined : undefined),
  }),
);
type _grouped = Expect<Equal<RowsOf<typeof grouped>, {}>>;
const answeredAll = both.pipe(answerAll(group, { peek: () => 1, poke: (_s) => {} }));
type _answeredAll = Expect<Equal<RowsOf<typeof answeredAll>, {}>>;
// a handler's program adds its row
const logging = both.pipe(
  handleAll(group, {
    peek: (_, resume) => Fail.fail("no" as const),
    poke: (_, resume) => resume(undefined),
  }),
);
type _logging = Expect<Equal<keyof RowsOf<typeof logging>, "fail">>;
handleAll(group, {
  // @ts-expect-error resume is typed from the declaration
  peek: (_, resume) => resume("one"),
  poke: (_, resume) => resume(undefined),
});
// @ts-expect-error every effect in the group needs a handler
handleAll(group, { peek: (_, resume) => resume(1) });
handleAll(group, {
  // @ts-expect-error annotated params must match the declaration (#50)
  peek: (_p: string, resume: Resume<string>) => resume("x"),
  poke: (_, resume) => resume(undefined),
});
handleAll(group, {
  // @ts-expect-error an annotated resume must match the declaration
  peek: (_p, resume: Resume<string>) => resume("x"),
  poke: (_, resume) => resume(undefined),
});
// @ts-expect-error answerAll answers with the declared type
answerAll(group, { peek: () => "one", poke: () => {} });
// @ts-expect-error an annotated payload must match the declaration
answerAll(group, { peek: () => 1, poke: (_s: number) => {} });
const Other = effect<void, string>()("peek");
// @ts-expect-error the program's row must hold the group's effects at their declared types
Other(undefined).pipe(handleAll(group, { peek: (_, r) => r(1), poke: (_, r) => r(undefined) }));

declare const first: boolean;
const twoAsks = Kyoot.gen(function* () {
  if (first) return yield* op<1 | 2>()("pick", "low" as const);
  return yield* op<2 | 3>()("pick", "high" as const);
});
type _twoAsksRow = Expect<Equal<RowsOf<typeof twoAsks>, { pick: Op<"low" | "high", 2> }>>;

const loose: KyootT<number, { fail: Op<FetchFailed | Declined, never> }> = Kyoot.succeed(1);
// @ts-expect-error a row cannot hold a bare payload
type _bareRow = KyootT<number, { fail: FetchFailed }>;

const handledStep = Kyoot.step(Kyoot.succeed(1));
type _handledStep = Expect<
  Equal<typeof handledStep, { readonly done: true; readonly value: number }>
>;
