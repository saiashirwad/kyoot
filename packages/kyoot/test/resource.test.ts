import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Async,
  CleanupError,
  Clock,
  effect,
  Fail,
  InterruptedError,
  Kyoot,
  Resource,
  Sync,
} from "../src/index.ts";
import { unsafeRunFiber } from "../src/internal/run-fiber.ts";

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

test("Resource: promise acquire and release are awaited", async () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    const value = yield* Resource.acquirePromise(
      async () => {
        await Promise.resolve();
        events.push("acquire");
        return "value";
      },
      async (resource) => {
        await Promise.resolve();
        events.push(`release ${resource}`);
      },
    );
    events.push(value);
    return value;
  }).pipe(Resource.run);
  assert.equal(await Kyoot.runPromise(prog), "value");
  assert.deepEqual(events, ["acquire", "value", "release value"]);
});

test("Resource owns a promised finalizer before a sync edge rejects async work", async () => {
  const promise = Promise.reject(new Error("late release failure"));
  let unhandled = false;
  const onUnhandled = () => (unhandled = true);
  process.once("unhandledRejection", onUnhandled);
  const program = Resource.acquire(
    () => "value",
    () => promise,
  ).pipe(Resource.run);

  assert.throws(() => Kyoot.runSync(program as never), CleanupError);
  await new Promise<void>((resolve) => setImmediate(resolve));
  process.removeListener("unhandledRejection", onUnhandled);
  assert.equal(unhandled, false);
});

test("Resource: interruption during promised acquire still releases the acquired value", async () => {
  let resolve!: (value: string) => void;
  const opened = new Promise<string>((done) => (resolve = done));
  const released: string[] = [];
  const fiber = unsafeRunFiber(
    Resource.acquirePromise(
      () => opened,
      async (value) => {
        released.push(value);
      },
    ).pipe(Resource.run),
  );

  fiber.interrupt();
  resolve("late");
  await assert.rejects(fiber.promise, InterruptedError);
  assert.deepEqual(released, ["late"]);
});

test("Resource: effectful acquire and release are interpreted", () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    const value = yield* Resource.acquireEffect(
      () => Kyoot.succeed("effect-value").map((v) => (events.push("acquire"), v)),
      (resource) => Kyoot.succeed(undefined).map(() => events.push(`release ${resource}`)),
    );
    events.push(value);
    return value;
  }).pipe(Resource.run);
  assert.equal(Kyoot.runSync(prog), "effect-value");
  assert.deepEqual(events, ["acquire", "effect-value", "release effect-value"]);
});

test("Resource: plain acquire keeps a Kyoot opener as a value", () => {
  const marker = Kyoot.succeed("marker");
  const program = Kyoot.gen(function* () {
    return yield* Resource.acquire(
      () => marker,
      () => undefined,
    );
  }).pipe(Resource.run);
  assert.equal(Kyoot.runSync(program), marker);
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
    Ask.handle({
      onOp: (_, resume) => Sync.defer(() => events.push("asked")).flatMap(() => resume(7)),
    }),
    Sync.run,
    Kyoot.runSync,
  );
  assert.equal(r, 7);
  assert.deepEqual(events, ["open", "asked", "got 7", "close"]);
});

test("a handler that claims a resume token and discards it still releases", () => {
  const events: string[] = [];
  const Ask = effect<string, number>()("ask");
  const r = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => events.push("open"),
      () => events.push("close"),
    );
    yield* Ask("n");
    return "never";
  }).pipe(
    Resource.run,
    Ask.handle({ onOp: (_, resume) => (resume(42), Kyoot.succeed("discarded")) }),
    Kyoot.runSync,
  );
  assert.equal(r, "discarded");
  assert.deepEqual(events, ["open", "close"]);
});

test("a handler that claims a resume.with token and discards it still releases", () => {
  const events: string[] = [];
  const Ask = effect<string, number>()("ask");
  const r = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => events.push("open"),
      () => events.push("close"),
    );
    yield* Ask("n");
    return "never";
  }).pipe(
    Resource.run,
    Ask.handle({
      onOp: (_, resume) => (resume.with(Kyoot.succeed(42)), Kyoot.succeed("discarded")),
    }),
    Kyoot.runSync,
  );
  assert.equal(r, "discarded");
  assert.deepEqual(events, ["open", "close"]);
});

test("a discarded resume token releases nested captured resources, innermost first", () => {
  const events: string[] = [];
  const Ask = effect<string, number>()("ask");
  const r = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => events.push("open outer"),
      () => events.push("close outer"),
    );
    yield* Kyoot.gen(function* () {
      yield* Resource.acquire(
        () => events.push("open inner"),
        () => events.push("close inner"),
      );
      yield* Ask("n");
    }).pipe(Resource.run);
    return "never";
  }).pipe(
    Resource.run,
    Ask.handle({ onOp: (_, resume) => (resume(42), Kyoot.succeed("discarded nested")) }),
    Kyoot.runSync,
  );
  assert.equal(r, "discarded nested");
  assert.deepEqual(events, ["open outer", "open inner", "close inner", "close outer"]);
});

test("a discarded resume token releases a captured resource whose finalizer is async", async () => {
  const events: string[] = [];
  const Ask = effect<string, number>()("ask");
  const r = await Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => events.push("open"),
      () => Async.fromPromise(async () => void events.push("close")),
    );
    yield* Ask("n");
    return "never";
  }).pipe(
    Resource.run,
    Ask.handle({ onOp: (_, resume) => (resume(42), Kyoot.succeed("discarded")) }),
    Kyoot.runPromise,
  );
  assert.equal(r, "discarded");
  assert.deepEqual(events, ["open", "close"]);
});

test("a resume token returned later in the handler's program still resumes", () => {
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
    Ask.handle({
      onOp: (_, resume) => {
        const token = resume(7);
        return Sync.defer(() => events.push("asked")).flatMap(() => token);
      },
    }),
    Sync.run,
    Kyoot.runSync,
  );
  assert.equal(r, 7);
  assert.deepEqual(events, ["open", "asked", "got 7", "close"]);
});

test("Resource: sync and async edges release before reporting an unhandled effect", async () => {
  const Missing = effect<undefined, never>()("resource/missing-at-edge");
  const events: string[] = [];
  const program = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => events.push("open"),
      () => events.push("close"),
    );
    return yield* Missing(undefined);
  }).pipe(Resource.run);

  assert.throws(
    () => Kyoot.runSync(program as never),
    (error: unknown) =>
      error instanceof Error && error.message.includes("resource/missing-at-edge"),
  );
  await assert.rejects(
    Kyoot.runPromise(program as never),
    (error: unknown) =>
      error instanceof Error && error.message.includes("resource/missing-at-edge"),
  );
  assert.deepEqual(events, ["open", "close", "open", "close"]);
});

test("Resource: every finalizer is tried and its cause is kept", async () => {
  const Missing = effect<undefined, never>()("resource/missing-finalizer");
  const defect = new Error("cleanup defect");
  const events: string[] = [];
  const program = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => 1,
      () => events.push("ok"),
    );
    yield* Resource.acquire(
      () => 2,
      () => (events.push("unhandled"), Missing(undefined)),
    );
    yield* Resource.acquire(
      () => 3,
      () => (events.push("fail"), Fail.fail("cleanup failure")),
    );
    yield* Resource.acquire(
      () => 4,
      () =>
        Async.fromPromise(() => {
          events.push("interrupted");
          return Promise.reject(new InterruptedError("cleanup interrupted"));
        }),
    );
    yield* Resource.acquire(
      () => 5,
      () => {
        events.push("defect");
        throw defect;
      },
    );
  }).pipe(Resource.run);

  await assert.rejects(unsafeRunFiber(program).promise, (error: unknown) => {
    assert.ok(error instanceof CleanupError);
    assert.deepEqual(
      error.failures.map((failure) => failure._tag),
      ["Defect", "Interrupted", "Fail", "Defect"],
    );
    assert.equal(error.failures[0]?._tag === "Defect" && error.failures[0].defect, defect);
    return true;
  });
  assert.deepEqual(events, ["defect", "interrupted", "fail", "unhandled", "ok"]);
});

test("Resource: a main failure stays primary when cleanup also fails", () => {
  const body = new Error("body");
  const cleanup = new Error("cleanup");
  const result = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => 1,
      (): void => {
        throw cleanup;
      },
    );
    throw body;
  }).pipe(Resource.run, Fail.run, Kyoot.runSync);

  assert.ok(!result.ok && result.cause._tag === "Defect");
  assert.equal(!result.ok && result.cause._tag === "Defect" && result.cause.defect, body);
  assert.deepEqual(!result.ok && result.cause.cleanup, [{ _tag: "Defect", defect: cleanup }]);
});

test("Resource: a typed failure stays primary in either handler order", () => {
  const make = () =>
    Kyoot.gen(function* () {
      yield* Resource.acquire(
        () => 1,
        () => Fail.fail("cleanup" as const),
      );
      return yield* Fail.fail("body" as const);
    });

  const outside = make().pipe(Resource.run, Fail.run, Kyoot.runSync);
  const inside = Kyoot.runSync(make().pipe(Fail.run, Resource.run) as never) as typeof outside;
  for (const result of [inside, outside]) {
    assert.ok(!result.ok && result.cause._tag === "Fail");
    assert.equal(!result.ok && result.cause._tag === "Fail" && result.cause.error, "body");
    assert.deepEqual(!result.ok && result.cause.cleanup, [{ _tag: "Fail", error: "cleanup" }]);
  }
});

test("Resource: an interrupt during cleanup waits for the protected finalizer", async () => {
  let started!: () => void;
  let finish!: () => void;
  const cleanupStarted = new Promise<void>((resolve) => (started = resolve));
  const mayFinish = new Promise<void>((resolve) => (finish = resolve));
  const events: string[] = [];
  const child = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => 1,
      () => events.push("last"),
    );
    yield* Resource.acquire(
      () => 2,
      () =>
        Async.fromPromise(async (signal) => {
          events.push(`start ${signal.aborted}`);
          started();
          await mayFinish;
          events.push(`end ${signal.aborted}`);
        }),
    );
  }).pipe(Resource.run);

  const result = await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const fiber = yield* Async.fork(child);
      yield* Async.fromPromise(() => cleanupStarted);
      yield* fiber.interrupt;
      finish();
      return yield* fiber.await;
    }),
  );

  assert.ok(!result.ok && result.cause._tag === "Interrupted");
  assert.deepEqual(events, ["start false", "end false", "last"]);
});
