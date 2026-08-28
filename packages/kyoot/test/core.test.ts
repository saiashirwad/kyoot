import assert from "node:assert/strict";
import { test } from "node:test";
import { KyootImpl, makeHandler, makeOp, succeed } from "../src/core.ts";
import {
  Async,
  Clock,
  effect,
  Emit,
  Env,
  Fail,
  Kyoot,
  Log,
  Random,
  Resource,
  Sync,
  Var,
} from "../src/index.ts";

const Count = Var.tag<number>()("Count");

test("map auto-flattens a returned Kyo", () => {
  const n = Kyoot.runSync(Kyoot.succeed(1).map((x) => Kyoot.succeed(x + 1)));
  assert.equal(n, 2);
});

test("map chains are trampolined: 100k maps, no stack overflow", () => {
  let k = Kyoot.succeed(0);
  for (let i = 0; i < 100_000; i++) k = k.map((x) => x + 1);
  assert.equal(Kyoot.runSync(k), 100_000);
});

test("pipe threads the computation through functions", () => {
  const n = Kyoot.succeed(2).pipe(
    (k) => k.map((x) => x + 1),
    (k) => k.map((x) => x * 10),
    Kyoot.runSync,
  );
  assert.equal(n, 30);
});

test("gen: yield* plain values and sub-computations", () => {
  const prog = Kyoot.gen(function* () {
    const a = yield* Kyoot.succeed(1);
    const b = yield* Kyoot.gen(function* () {
      return 2;
    });
    return a + b;
  });
  assert.equal(Kyoot.runSync(prog), 3);
});

test("gen with an effect, handled", () => {
  const prog = Kyoot.gen(function* () {
    yield* Count.set(5);
    const v = yield* Count.get();
    return v * 2;
  }).pipe(Count.run(0));
  assert.deepEqual(Kyoot.runSync(prog), [10, 5]);
});

test("a throw inside map is a defect and surfaces at the edge as-is", () => {
  const boom = new Error("boom");
  const k = Kyoot.succeed(1).map(() => {
    throw boom;
  });
  assert.throws(
    () => Kyoot.runSync(k),
    (e) => e === boom,
  );
});

test("a throw inside a gen body is a defect", () => {
  const boom = new Error("boom");
  const k = Kyoot.gen(function* () {
    yield* Kyoot.succeed(1);
    throw boom;
  });
  assert.throws(
    () => Kyoot.runSync(k),
    (e) => e === boom,
  );
});

test("runSync on an unhandled effect fails loudly at runtime", () => {
  const k = makeOp("nope", undefined);
  assert.throws(
    () => Kyoot.runSync(k as never),
    (e: unknown) => e instanceof Error && e.message.includes("unhandled effect 'nope'"),
  );
});

test("a continuation may only be resumed once", () => {
  const k = new KyootImpl({
    _tag: "handler",
    effectKey: "myfx",
    self: Kyoot.gen(function* () {
      const v = yield* makeOp("myfx", undefined);
      return (v as number) * 10;
    }),
    onOp: (_p, resume) => {
      const first = resume(1);
      return first.map(() => resume(2));
    },
  });
  assert.throws(() => Kyoot.runSync(k as never), /continuation resumed twice \(one-shot law\)/);
});

test("a handler that resumes zero times short-circuits", () => {
  const k = new KyootImpl({
    _tag: "handler",
    effectKey: "myfx",
    self: Kyoot.gen(function* () {
      yield* makeOp("myfx", undefined);
      return "unreachable";
    }).map(() => "also unreachable"),
    onOp: () => succeed("short"),
  });
  assert.equal(Kyoot.runSync(k as never), "short");
});

test("an op escaping a yielded handler node keeps the outer continuation", () => {
  const inner = new KyootImpl({
    _tag: "handler",
    effectKey: "inner",
    self: makeOp("outer", undefined),
    onOp: () => succeed("nope"),
  });
  const prog = Kyoot.gen(function* () {
    const v = yield* inner;
    return `${v} continued`;
  });
  const k = new KyootImpl({
    _tag: "handler",
    effectKey: "outer",
    self: prog,
    onOp: (_p, resume) => resume("handled"),
  });
  assert.equal(Kyoot.runSync(k as never), "handled continued");
});

test("a throw inside onOp goes to the same handler's onDefect", () => {
  const boom = new Error("boom");
  const k = makeHandler("myfx", makeOp("myfx", undefined) as never, {
    onOp: () => {
      throw boom;
    },
    onDefect: (d) => succeed(d === boom ? "caught" : "wrong"),
  });
  assert.equal(Kyoot.runSync(k as never), "caught");
});

test("resume.with continues the program at the op, where its own handlers see it", () => {
  const Fetch = effect<string, string, string>()("fetch");
  const program = Fetch("a").pipe(Fail.catchAll((e: string) => Kyoot.succeed(`caught ${e}`)));
  const failing = Fetch.handle({ onOp: (url, resume) => resume.with(Fail.fail(`no ${url}`)) });
  assert.equal(Kyoot.runSync(program.pipe(failing)), "caught no a");
});

test("intercept answers some ops and performs the rest for the handler outside", () => {
  const Fetch = effect<string, string>()("fetch");
  const cache = Fetch.intercept((url, next) =>
    url === "hot" ? Kyoot.succeed("cached") : next(url),
  );
  const live = Fetch.handle({ onOp: (url, resume) => resume(`fetched ${url}`) });
  const program = Kyoot.gen(function* () {
    return [yield* Fetch("hot"), yield* Fetch("cold")];
  });
  assert.deepEqual(Kyoot.runSync(program.pipe(cache, live)), ["cached", "fetched cold"]);
});

test("intercept with a cell: state per run, fresh each run", () => {
  const Fetch = effect<string, string>()("fetch");
  const memo = Fetch.intercept({ create: () => new Map<string, string>() }, (url, next, cache) => {
    const hit = cache.get(url);
    return hit !== undefined ? Kyoot.succeed(hit) : next(url).map((a) => (cache.set(url, a), a));
  });
  let calls = 0;
  const live = Fetch.handle({ onOp: (url, resume) => resume(`${url}#${++calls}`) });
  const program = Kyoot.gen(function* () {
    return [yield* Fetch("a"), yield* Fetch("a"), yield* Fetch("b")];
  });
  const piped = program.pipe(memo, live);
  assert.deepEqual(Kyoot.runSync(piped), ["a#1", "a#1", "b#2"]);
  assert.deepEqual(Kyoot.runSync(piped), ["a#3", "a#3", "b#4"]);
});

test("Clock, Log, and Random intercept: scale time, redact, fix the dice", () => {
  const fast = Clock.intercept((ms, next) => next(ms / 10));
  const redact = Log.intercept((e, next) =>
    next({ ...e, message: e.message.replace(/\d{4}/g, "****") }),
  );
  const loaded = Random.intercept(() => Kyoot.succeed(0.5));
  const program = Kyoot.gen(function* () {
    yield* Clock.sleep(1000);
    yield* Log.info("card 4242");
    return yield* Random.int(6);
  });
  const [[n, logs], elapsed] = program.pipe(
    fast,
    redact,
    loaded,
    Log.collect,
    Clock.virtual,
    Kyoot.runSync,
  );
  assert.equal(n, 3);
  assert.equal(logs[0]?.message, "card ****");
  assert.equal(elapsed, 100);
});

test("Clock.intercept caps real sleeps under runPromise", async () => {
  const capped = Clock.intercept((ms, next) => next(Math.min(ms, 1)));
  const start = Date.now();
  await Kyoot.runPromise(Clock.sleep(10_000).pipe(capped));
  assert.ok(Date.now() - start < 1000);
});

test("Emit and Sync intercept: rewrite values, wrap thunks", () => {
  const double = Emit.intercept<number>()((e, next) => next(e * 2));
  let thunks = 0;
  const counted = Sync.intercept((f, next) => (thunks++, next(f)));
  const program = Kyoot.gen(function* () {
    yield* Emit.value(1);
    yield* Emit.value(2);
    return yield* Sync.defer(() => 40);
  });
  const [v, emitted] = program.pipe(double, counted, Emit.collect, Sync.run, Kyoot.runSync);
  assert.deepEqual([v, emitted, thunks], [40, [2, 4], 1]);
});

test("Fail.intercept sees a failure on its way out and passes it on", () => {
  const tap = Fail.intercept<string>()((e, next) => Log.error(e).map(() => next(`${e}!`)));
  const [r, logs] = Fail.fail("boom").pipe(tap, Fail.run, Log.collect, Kyoot.runSync);
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(r.cause, { _tag: "Fail", error: "boom!" });
  assert.equal(logs[0]?.message, "boom");
});

test("Env intercept wraps the service the handler outside provides", () => {
  const Db = Env.tag<{ find(id: string): string }>()("db");
  const loud = Db.intercept((_, next) =>
    next().map((db) => ({ find: (id: string) => db.find(id).toUpperCase() })),
  );
  const program = Kyoot.gen(function* () {
    return (yield* Db).find("1");
  });
  assert.equal(program.pipe(loud, Db.provide({ find: () => "ada" }), Kyoot.runSync), "ADA");
});

test("Var intercept validates a set; the failure lands at the set", () => {
  const Balance = Var.tag<number>()("balance");
  class Negative {
    readonly _tag = "Negative";
  }
  const guard = Balance.intercept((op, next) =>
    op.kind === "set" && op.value < 0 ? Fail.fail(new Negative()) : next(op),
  );
  const program = Kyoot.gen(function* () {
    yield* Balance.set(5);
    const refused = yield* Balance.set(-1).pipe(
      Fail.catchTag("Negative", () => Kyoot.succeed("refused")),
    );
    return [yield* Balance.get(), refused];
  });
  const [[v, refused], final] = program.pipe(guard, Balance.run(0), Fail.orThrow, Kyoot.runSync);
  assert.deepEqual([v, refused, final], [5, "refused", 5]);
});

test("Resource intercept sees each acquire", () => {
  const opened: unknown[] = [];
  const audit = Resource.intercept()((op, next) =>
    next({
      ...op,
      acquire: () => {
        const r = op.acquire();
        opened.push(r);
        return r;
      },
    }),
  );
  const program = Resource.acquire(
    () => "conn",
    () => {},
  );
  assert.equal(program.pipe(audit, Resource.run, Kyoot.runSync), "conn");
  assert.deepEqual(opened, ["conn"]);
});

test("Async intercept sees every async op; a fiber forked through it keeps the frames inside", async () => {
  let ops = 0;
  const count = Async.intercept((op, next) => (ops++, next(op)));
  const program = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(Log.info("from fiber").map(() => 1));
    const v = yield* fiber.join;
    yield* Log.info("from parent");
    return v;
  });
  const [v, logs] = await Kyoot.runPromise(program.pipe(Log.collect, count));
  assert.equal(v, 1);
  assert.deepEqual(
    logs.map((l) => l.message),
    ["from fiber", "from parent"],
  );
  assert.ok(ops >= 2, `fork and join were intercepted (${ops})`);
});
