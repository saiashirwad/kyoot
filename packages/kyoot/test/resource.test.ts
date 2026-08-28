import assert from "node:assert/strict";
import { test } from "node:test";
import { Async, Clock, effect, Fail, Kyoot, Resource, Sync } from "../src/index.ts";

test("Resource: release runs on success", () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    const conn = yield* Resource.acquire(
      () => {
        events.push("acquire");
        return "conn";
      },
      () => events.push("release"),
    );
    events.push(`use ${conn}`);
    return "done";
  });
  assert.equal(Kyoot.runSync(prog.pipe(Resource.run)), "done");
  assert.deepEqual(events, ["acquire", "use conn", "release"]);
});

test("Resource: finalizers run in LIFO order", () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => "a",
      () => events.push("release a"),
    );
    yield* Resource.acquire(
      () => "b",
      () => events.push("release b"),
    );
    return null;
  });
  Kyoot.runSync(prog.pipe(Resource.run));
  assert.deepEqual(events, ["release b", "release a"]);
});

test("Resource: release runs on typed failure (Resource outside Fail)", () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => "conn",
      () => events.push("release"),
    );
    yield* Fail.fail("boom");
    return "unreachable";
  }).pipe(Fail.run, Resource.run);
  assert.deepEqual(Kyoot.runSync(prog), { ok: false, cause: { _tag: "Fail", error: "boom" } });
  assert.deepEqual(events, ["release"]);
});

test("Resource: release runs on defect", () => {
  const events: string[] = [];
  const boom = new Error("boom");
  const prog = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => "conn",
      () => events.push("release"),
    );
    yield* Kyoot.succeed(0).map(() => {
      throw boom;
    });
    return "unreachable";
  }).pipe(Resource.run);
  assert.throws(
    () => Kyoot.runSync(prog),
    (e) => e === boom,
  );
  assert.deepEqual(events, ["release"]);
});

const slowClose = (events: string[], name: string) =>
  Resource.acquire(
    () => events.push(`open ${name}`),
    () => Clock.sleep(5).map(() => void events.push(`close ${name}`)),
  );

test("Resource: a finalizer may be a program (runs on success)", async () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    yield* slowClose(events, "a");
    yield* slowClose(events, "b");
    return "done";
  });
  assert.equal(await Kyoot.runPromise(prog.pipe(Resource.run)), "done");
  assert.deepEqual(events, ["open a", "open b", "close b", "close a"]);
});

test("Resource: program finalizers run on defect and the defect wins", async () => {
  const events: string[] = [];
  const boom = new Error("boom");
  const prog = Kyoot.gen(function* () {
    yield* slowClose(events, "a");
    yield* Async.fromPromise(() => Promise.reject(boom));
  });
  await assert.rejects(Kyoot.runPromise(prog.pipe(Resource.run)), (e) => e === boom);
  assert.deepEqual(events, ["open a", "close a"]);
});

test("Resource: program finalizers run to completion on interrupt", async () => {
  const events: string[] = [];
  const r = await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const fiber = yield* Async.fork(
        Kyoot.gen(function* () {
          yield* slowClose(events, "a");
          yield* Clock.sleep(10_000);
        }).pipe(Resource.run),
      );
      yield* Clock.sleep(5);
      yield* fiber.interrupt;
      return yield* fiber.await;
    }),
  );
  assert.ok(!r.ok && r.cause._tag === "Interrupted");
  assert.deepEqual(events, ["open a", "close a"]);
});

test("a rejected async op is a defect that handlers see", async () => {
  const boom = new Error("boom");
  const events: string[] = [];
  const r = await Kyoot.runPromise(
    Kyoot.gen(function* () {
      yield* Resource.acquire(
        () => events.push("open"),
        () => events.push("close"),
      );
      yield* Async.fromPromise(() => Promise.reject(boom));
    }).pipe(Resource.run, Fail.run),
  );
  assert.ok(!r.ok && r.cause._tag === "Defect" && r.cause.defect === boom);
  assert.deepEqual(events, ["open", "close"]);
});

test("Resource: an acquire that throws releases what the scope already holds", () => {
  const events: string[] = [];
  const boom = new Error("boom");
  const prog = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => events.push("open a"),
      () => events.push("close a"),
    );
    yield* Resource.acquire(
      () => {
        throw boom;
      },
      () => events.push("never"),
    );
  }).pipe(Resource.run);
  assert.throws(
    () => Kyoot.runSync(prog),
    (e) => e === boom,
  );
  assert.deepEqual(events, ["open a", "close a"]);
});

// A handler outside Resource.run that does not resume drops the scope. The
// scope is unwound as on an interrupt, so the order of the two no longer
// matters for cleanup.

class Boom {
  readonly _tag = "Boom";
}

test("Resource inside Fail.run: a failure still releases", () => {
  const events: string[] = [];
  const r = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => events.push("open"),
      () => events.push("close"),
    );
    yield* Fail.fail(new Boom());
  }).pipe(Resource.run, Fail.run, Kyoot.runSync);
  assert.ok(!r.ok && r.cause._tag === "Fail" && r.cause.error instanceof Boom);
  assert.deepEqual(events, ["open", "close"]);
});

test("Resource inside catchAll: the recovery runs, then the scope is released", () => {
  const events: string[] = [];
  const a = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => events.push("open"),
      () => events.push("close"),
    );
    yield* Fail.fail(new Boom());
    return "never";
  }).pipe(
    Resource.run,
    Fail.catchAll(() => Sync.defer(() => (events.push("recover"), "recovered"))),
    Sync.run,
    Kyoot.runSync,
  );
  assert.equal(a, "recovered");
  assert.deepEqual(events, ["open", "recover", "close"]);
});

test("Resource inside a catchTag that passes the failure on: the outer catch releases", () => {
  const events: string[] = [];
  const r = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => events.push("open a"),
      () => events.push("close a"),
    );
    yield* Resource.acquire(
      () => events.push("open b"),
      () => events.push("close b"),
    );
    yield* Fail.fail(new Boom());
  }).pipe(
    Resource.run,
    Fail.catchTag("Other", () => Kyoot.succeed(undefined)),
    Fail.run,
    Kyoot.runSync,
  );
  assert.ok(!r.ok);
  assert.deepEqual(events, ["open a", "open b", "close b", "close a"]);
});

test("a handler that performs an op and then does not resume releases after its op", () => {
  const events: string[] = [];
  const Stop = effect<string, never>()("stop");
  const r = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => events.push("open"),
      () => events.push("close"),
    );
    yield* Stop("now");
    return "never";
  }).pipe(
    Resource.run,
    Stop.handle({ onOp: (why) => Sync.defer(() => (events.push(`stopped: ${why}`), "stopped")) }),
    Sync.run,
    Kyoot.runSync,
  );
  assert.equal(r, "stopped");
  assert.deepEqual(events, ["open", "stopped: now", "close"]);
});

test("a handler that resumes does not release early", () => {
  const events: string[] = [];
  const Ask = effect<string, number>()("ask");
  const r = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => events.push("open"),
      () => events.push("close"),
    );
    const n = yield* Ask("n");
    events.push(`got ${n}`);
    return n;
  }).pipe(
    Resource.run,
    Ask.handle({ onOp: (_, resume) => Sync.defer(() => events.push("asked")).flatMap(() => resume(7)) }),
    Sync.run,
    Kyoot.runSync,
  );
  assert.equal(r, 7);
  assert.deepEqual(events, ["open", "asked", "got 7", "close"]);
});
