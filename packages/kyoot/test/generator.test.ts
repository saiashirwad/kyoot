import assert from "node:assert/strict";
import { test } from "node:test";
import { Async, Clock, effect, Fail, Kyoot, Resource, Sync } from "../src/index.ts";

const Stop = effect<string, never>()("stop");
const Hold = effect<undefined, undefined>()("hold");
const Relay = effect<undefined, undefined>()("relay");
const Missing = effect<undefined, never>()("missing");

test("generator: finally runs when Fail.run drops the continuation", () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    try {
      yield* Fail.fail("stop");
    } finally {
      events.push("finally");
    }
  }).pipe(Fail.run);
  assert.deepEqual(Kyoot.runSync(prog), { ok: false, cause: { _tag: "Fail", error: "stop" } });
  assert.deepEqual(events, ["finally"]);
});

test("generator: catchAll recovers, then the dropped frame closes", () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    try {
      yield* Fail.fail("stop");
    } finally {
      events.push("finally");
    }
  }).pipe(
    Fail.catchAll(() =>
      Sync.defer(() => {
        events.push("recover");
        return "recovered";
      }),
    ),
    Sync.run,
  );
  assert.equal(Kyoot.runSync(prog), "recovered");
  assert.deepEqual(events, ["recover", "finally"]);
});

test("generator: finally runs when Fail.orThrow drops the continuation", () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    try {
      yield* Fail.fail("stop");
    } finally {
      events.push("finally");
    }
  }).pipe(Fail.orThrow);
  assert.throws(
    () => Kyoot.runSync(prog),
    (e: unknown) => e === "stop",
  );
  assert.deepEqual(events, ["finally"]);
});

test("generator: finally runs when a custom handler answers without resuming", () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    try {
      yield* Stop("now");
    } finally {
      events.push("finally");
    }
    return "unreachable";
  }).pipe(Stop.handle({ onOp: (reason) => Kyoot.succeed(`stopped: ${reason}`) }));
  assert.equal(Kyoot.runSync(prog), "stopped: now");
  assert.deepEqual(events, ["finally"]);
});

test("generator: nested generators close innermost first", () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    try {
      yield* Kyoot.gen(function* () {
        try {
          yield* Fail.fail("stop");
        } finally {
          events.push("inner");
        }
      });
    } finally {
      events.push("outer");
    }
  }).pipe(Fail.run);
  assert.equal(Kyoot.runSync(prog).ok, false);
  assert.deepEqual(events, ["inner", "outer"]);
});

test("generator: a defect closes the frames it unwinds past", () => {
  const events: string[] = [];
  const boom = new Error("boom");
  const prog = Kyoot.gen(function* () {
    try {
      yield* Kyoot.gen(function* () {
        try {
          yield* Sync.defer(() => {
            throw boom;
          });
        } finally {
          events.push("inner");
        }
      });
    } finally {
      events.push("outer");
    }
  }).pipe(Sync.run, Fail.run);
  const r = Kyoot.runSync(prog);
  assert.equal(!r.ok && r.cause._tag === "Defect" && r.cause.defect, boom);
  assert.deepEqual(events, ["inner", "outer"]);
});

test("generator: finally still runs on normal completion and on a thrown error", () => {
  const events: string[] = [];
  assert.equal(
    Kyoot.runSync(
      Kyoot.gen(function* () {
        try {
          return yield* Kyoot.succeed("done");
        } finally {
          events.push("returned");
        }
      }),
    ),
    "done",
  );
  const boom = new Error("boom");
  assert.throws(
    () =>
      Kyoot.runSync(
        Kyoot.gen(function* () {
          try {
            yield* Kyoot.succeed(1);
            throw boom;
          } finally {
            events.push("threw");
          }
        }),
      ),
    (e: unknown) => e === boom,
  );
  assert.deepEqual(events, ["returned", "threw"]);
});

test("generator: finally runs before an outer Resource releases", () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => "conn",
      () => events.push("release"),
    );
    try {
      yield* Fail.fail("stop");
    } finally {
      events.push("finally");
    }
  }).pipe(Resource.run, Fail.run);
  assert.equal(Kyoot.runSync(prog).ok, false);
  assert.deepEqual(events, ["finally", "release"]);
});

test("generator: a finally that yields is a defect, not half-run cleanup", () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    try {
      yield* Fail.fail("stop");
    } finally {
      yield* Kyoot.succeed(1);
      events.push("after the yield");
    }
  }).pipe(Fail.run);
  assert.throws(
    () => Kyoot.runSync(prog),
    (e: unknown) => e instanceof Error && e.message.includes("finally yielded an effect"),
  );
  assert.deepEqual(events, []);
});

test("generator: a finally that throws surfaces after the rest of the cleanup", () => {
  const events: string[] = [];
  const boom = new Error("from finally");
  const raise = () => {
    throw boom;
  };
  const prog = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => "conn",
      () => events.push("release"),
    );
    try {
      yield* Fail.fail("stop");
    } finally {
      raise();
    }
  }).pipe(Resource.run, Fail.run);
  assert.throws(
    () => Kyoot.runSync(prog),
    (e: unknown) => e === boom,
  );
  assert.deepEqual(events, ["release"]);
});

test("generator: a held continuation is not closed until it is dropped", async () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    try {
      const a = yield* Async.fromPromise(async () => "a");
      events.push(`resumed ${a}`);
      return a;
    } finally {
      events.push("finally");
    }
  });
  assert.equal(await Kyoot.runPromise(prog), "a");
  assert.deepEqual(events, ["resumed a", "finally"]);
});

test("generator: an unhandled effect at the edge closes the frame", () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    try {
      yield* Stop("now");
    } finally {
      events.push("finally");
    }
  });
  assert.throws(
    () => Kyoot.runSync(prog as never),
    (e: unknown) => e instanceof Error && e.message.includes("unhandled effect 'stop'"),
  );
  assert.deepEqual(events, ["finally"]);
});

test("generator: finally runs when a fiber is interrupted", async () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(
      Kyoot.gen(function* () {
        try {
          yield* Async.never;
        } finally {
          events.push("finally");
        }
      }),
    );
    yield* fiber.interrupt;
    return yield* fiber.await;
  });
  const r = await Kyoot.runPromise(prog);
  assert.equal(!r.ok && r.cause._tag, "Interrupted");
  assert.deepEqual(events, ["finally"]);
});

test("generator: finally runs in the loser of a race", async () => {
  const events: string[] = [];
  const slow = Kyoot.gen(function* () {
    try {
      yield* Clock.sleep(10_000);
      return "slow";
    } finally {
      events.push("finally");
    }
  });
  assert.equal(
    await Kyoot.runPromise(
      Async.race(
        slow,
        Clock.sleep(5).map(() => "fast"),
      ),
    ),
    "fast",
  );
  assert.deepEqual(events, ["finally"]);
});

test("generator: a drop that ends in an unhandled effect still closes the frame", () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    try {
      yield* Stop("now");
    } finally {
      events.push("finally");
    }
  }).pipe(Stop.handle({ onOp: () => Missing(undefined) }));
  assert.throws(
    () => Kyoot.runSync(prog as never),
    (e: unknown) => e instanceof Error && e.message.includes("unhandled effect 'missing'"),
  );
  assert.deepEqual(events, ["finally"]);
});

test("generator: nested held continuations all close when the machine stops", () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    try {
      yield* Kyoot.gen(function* () {
        try {
          yield* Relay(undefined);
        } finally {
          events.push("inner");
        }
      });
    } finally {
      events.push("outer");
    }
  }).pipe(
    Relay.handle({ onOp: (_payload, resume) => Hold(undefined).flatMap(() => resume(undefined)) }),
    Hold.handle({ onOp: () => Missing(undefined) }),
  );
  assert.throws(
    () => Kyoot.runSync(prog as never),
    (e: unknown) => e instanceof Error && e.message.includes("unhandled effect 'missing'"),
  );
  assert.deepEqual(events, ["inner", "outer"]);
});

test("generator: a claimed continuation that never lands closes too", () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    try {
      yield* Hold(undefined);
    } finally {
      events.push("finally");
    }
  }).pipe(
    Hold.handle({
      onOp: (_payload, resume) => {
        const landing = resume(undefined);
        return Missing(undefined).flatMap(() => landing);
      },
    }),
  );
  assert.throws(
    () => Kyoot.runSync(prog as never),
    (e: unknown) => e instanceof Error && e.message.includes("unhandled effect 'missing'"),
  );
  assert.deepEqual(events, ["finally"]);
});
