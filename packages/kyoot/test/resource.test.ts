import assert from "node:assert/strict";
import { test } from "node:test";
import { effect, Kyoot } from "../src/index.ts";
import * as Fail from "../src/effects/fail.ts";
import * as Resource from "../src/effects/resource.ts";
import { Async, Clock, runPromise } from "../src/async/index.ts";
import * as Sim from "../src/sim/index.ts";

test("Resource: release runs on success", () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    const conn = yield* Resource.acquire(
      Kyoot.sync(() => {
        events.push("acquire");
        return "conn";
      }),
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
    yield* Resource.acquire(Kyoot.succeed("a"), () => events.push("release a"));
    yield* Resource.acquire(Kyoot.succeed("b"), () => events.push("release b"));
    return null;
  });
  Kyoot.runSync(prog.pipe(Resource.run));
  assert.deepEqual(events, ["release b", "release a"]);
});

test("Resource: release runs on typed failure (Resource outside Fail)", () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    yield* Resource.acquire(Kyoot.succeed("conn"), () => events.push("release"));
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
    yield* Resource.acquire(Kyoot.succeed("conn"), () => events.push("release"));
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

const nap = (ms: number) => Clock.sleep(ms).pipe(Clock.live);

const slowClose = (events: string[], name: string) =>
  Resource.acquire(
    Kyoot.sync(() => events.push(`open ${name}`)),
    () => nap(5).map(() => void events.push(`close ${name}`)),
  );

test("Resource: a finalizer may be a program (runs on success)", async () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    yield* slowClose(events, "a");
    yield* slowClose(events, "b");
    return "done";
  });
  assert.equal(await runPromise(prog.pipe(Resource.run)), "done");
  assert.deepEqual(events, ["open a", "open b", "close b", "close a"]);
});

test("Resource: program finalizers run on defect and the defect wins", async () => {
  const events: string[] = [];
  const boom = new Error("boom");
  const prog = Kyoot.gen(function* () {
    yield* slowClose(events, "a");
    yield* Async.fromPromise(() => Promise.reject(boom));
  });
  await assert.rejects(runPromise(prog.pipe(Resource.run)), (e) => e === boom);
  assert.deepEqual(events, ["open a", "close a"]);
});

test("Resource: program finalizers run to completion on interrupt", async () => {
  const events: string[] = [];
  const r = await runPromise(
    Kyoot.gen(function* () {
      const fiber = yield* Async.fork(
        Kyoot.gen(function* () {
          yield* slowClose(events, "a");
          yield* nap(10_000);
        }).pipe(Resource.run),
      );
      yield* nap(5);
      yield* Async.interrupt(fiber);
      return yield* Async.wait(fiber);
    }),
  );
  assert.ok(!r.ok && r.cause._tag === "Interrupted");
  assert.deepEqual(events, ["open a", "close a"]);
});

test("a rejected async op is a defect that handlers see", async () => {
  const boom = new Error("boom");
  const events: string[] = [];
  const r = await runPromise(
    Kyoot.gen(function* () {
      yield* Resource.acquire(
        Kyoot.sync(() => events.push("open")),
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
      Kyoot.sync(() => events.push("open a")),
      () => events.push("close a"),
    );
    yield* Resource.acquire(
      Kyoot.sync((): never => {
        throw boom;
      }),
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
      Kyoot.sync(() => events.push("open")),
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
      Kyoot.sync(() => events.push("open")),
      () => events.push("close"),
    );
    yield* Fail.fail(new Boom());
    return "never";
  }).pipe(
    Resource.run,
    Fail.catchAll(() => Kyoot.sync(() => (events.push("recover"), "recovered"))),
    Kyoot.runSync,
  );
  assert.equal(a, "recovered");
  assert.deepEqual(events, ["open", "recover", "close"]);
});

test("Resource inside a catchTag that passes the failure on: the outer catch releases", () => {
  const events: string[] = [];
  const r = Kyoot.gen(function* () {
    yield* Resource.acquire(
      Kyoot.sync(() => events.push("open a")),
      () => events.push("close a"),
    );
    yield* Resource.acquire(
      Kyoot.sync(() => events.push("open b")),
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
      Kyoot.sync(() => events.push("open")),
      () => events.push("close"),
    );
    yield* Stop("now");
    return "never";
  }).pipe(
    Resource.run,
    Stop.handle((why) => Kyoot.sync(() => (events.push(`stopped: ${why}`), "stopped"))),
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
      Kyoot.sync(() => events.push("open")),
      () => events.push("close"),
    );
    const n = yield* Ask("n");
    events.push(`got ${n}`);
    return n;
  }).pipe(
    Resource.run,
    Ask.handle((_, resume) => Kyoot.sync(() => events.push("asked")).flatMap(() => resume(7))),
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
      Kyoot.sync(() => events.push("open")),
      () => events.push("close"),
    );
    yield* Ask("n");
    return "never";
  }).pipe(
    Resource.run,
    Ask.handle((_, resume) => (resume(42), Kyoot.succeed("discarded"))),
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
      Kyoot.sync(() => events.push("open")),
      () => events.push("close"),
    );
    yield* Ask("n");
    return "never";
  }).pipe(
    Resource.run,
    Ask.handle((_, resume) => (resume.with(Kyoot.succeed(42)), Kyoot.succeed("discarded"))),
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
      Kyoot.sync(() => events.push("open outer")),
      () => events.push("close outer"),
    );
    yield* Kyoot.gen(function* () {
      yield* Resource.acquire(
        Kyoot.sync(() => events.push("open inner")),
        () => events.push("close inner"),
      );
      yield* Ask("n");
    }).pipe(Resource.run);
    return "never";
  }).pipe(
    Resource.run,
    Ask.handle((_, resume) => (resume(42), Kyoot.succeed("discarded nested"))),
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
      Kyoot.sync(() => events.push("open")),
      () => Async.fromPromise(async () => void events.push("close")),
    );
    yield* Ask("n");
    return "never";
  }).pipe(
    Resource.run,
    Ask.handle((_, resume) => (resume(42), Kyoot.succeed("discarded"))),
    runPromise,
  );
  assert.equal(r, "discarded");
  assert.deepEqual(events, ["open", "close"]);
});

test("a resume token returned later in the handler's program still resumes", () => {
  const events: string[] = [];
  const Ask = effect<string, number>()("ask");
  const r = Kyoot.gen(function* () {
    yield* Resource.acquire(
      Kyoot.sync(() => events.push("open")),
      () => events.push("close"),
    );
    const n = yield* Ask("n");
    events.push(`got ${n}`);
    return n;
  }).pipe(
    Resource.run,
    Ask.handle((_, resume) => {
      const token = resume(7);
      return Kyoot.sync(() => events.push("asked")).flatMap(() => token);
    }),
    Kyoot.runSync,
  );
  assert.equal(r, 7);
  assert.deepEqual(events, ["open", "asked", "got 7", "close"]);
});

test("Resource: open may be async; its effects are in the row and release still runs", async () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    const conn = yield* Resource.acquire(
      Async.fromPromise(async () => {
        events.push("open");
        return "conn";
      }),
      (c) => Async.fromPromise(async () => void events.push(`close ${c}`)),
    );
    events.push(`use ${conn}`);
    return conn;
  });
  assert.equal(await runPromise(prog.pipe(Resource.run)), "conn");
  assert.deepEqual(events, ["open", "use conn", "close conn"]);
});

test("Resource: an open that fails with a typed error registers nothing", async () => {
  const events: string[] = [];
  const r = await runPromise(
    Kyoot.gen(function* () {
      yield* Resource.acquire(
        Kyoot.sync(() => events.push("open a")),
        () => events.push("close a"),
      );
      yield* Resource.acquire(Fail.fail("nope"), () => events.push("never"));
    }).pipe(Resource.run, Fail.run),
  );
  assert.ok(!r.ok && r.cause._tag === "Fail" && r.cause.error === "nope");
  assert.deepEqual(events, ["open a", "close a"]);
});

test("Resource: an open that dies registers nothing", async () => {
  const events: string[] = [];
  const boom = new Error("boom");
  const prog = Kyoot.gen(function* () {
    yield* Resource.acquire(
      Kyoot.sync(() => events.push("open a")),
      () => events.push("close a"),
    );
    yield* Resource.acquire(
      Async.fromPromise(() => Promise.reject(boom)),
      () => events.push("never"),
    );
  }).pipe(Resource.run);
  await assert.rejects(runPromise(prog), (e) => e === boom);
  assert.deepEqual(events, ["open a", "close a"]);
});

test("Resource: interrupting an open releases earlier resources and registers nothing", async () => {
  const events: string[] = [];
  const r = await runPromise(
    Kyoot.gen(function* () {
      const fiber = yield* Async.fork(
        Kyoot.gen(function* () {
          yield* Resource.acquire(
            Kyoot.sync(() => events.push("open a")),
            () => events.push("close a"),
          );
          yield* Resource.acquire(
            nap(10_000).map(() => events.push("open b")),
            () => events.push("close b"),
          );
        }).pipe(Resource.run),
      );
      yield* nap(5);
      yield* Async.interrupt(fiber);
      return yield* Async.wait(fiber);
    }),
  );
  assert.ok(!r.ok && r.cause._tag === "Interrupted");
  assert.deepEqual(events, ["open a", "close a"]);
});

test("Resource: async opens release in LIFO order", async () => {
  const events: string[] = [];
  const res = (name: string) =>
    Resource.acquire(
      nap(1).map(() => events.push(`open ${name}`)),
      () => nap(1).map(() => events.push(`close ${name}`)),
    );
  await runPromise(
    Kyoot.gen(function* () {
      yield* res("a");
      yield* res("b");
    }).pipe(Resource.run),
  );
  assert.deepEqual(events, ["open a", "open b", "close b", "close a"]);
});

const Note = effect<string, void>()("io/note");
const notes = () => {
  const seen: string[] = [];
  return { seen, "io/note": (s: string) => void seen.push(s) };
};

test("Resource under Sim.run: a resource opened through a world effect is released", () => {
  const res = (name: string) =>
    Resource.acquire(
      Note(`open ${name}`).map(() => name),
      (n) => Note(`close ${n}`),
    );
  const program = Kyoot.gen(function* () {
    yield* res("a");
    yield* res("b");
    return "done";
  }).pipe(Resource.run);
  const r = Sim.run(program, { seed: 1, world: notes });
  assert.deepEqual(r.exit, { ok: true, value: "done" });
  assert.deepEqual(r.world.seen, ["open a", "open b", "close b", "close a"]);
});

test("Resource under Sim.run: interrupting during open registers nothing", () => {
  const program = Kyoot.gen(function* () {
    const child = yield* Sim.fork(
      Kyoot.gen(function* () {
        yield* Resource.acquire(
          Note("open a").map(() => "a"),
          () => Note("close a"),
        );
        yield* Resource.acquire(
          Sim.sleep(60_000).map(() => "b"),
          () => Note("close b"),
        );
      }).pipe(Resource.run),
    );
    yield* Sim.sleep(1_000);
    yield* Sim.interrupt(child);
    return yield* Sim.wait(child);
  });
  const r = Sim.run(program, { seed: 2, world: notes });
  assert.deepEqual(r.world.seen, ["open a", "close a"]);
});
