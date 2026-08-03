import assert from "node:assert/strict";
import { test } from "node:test";
import { Fail, Async, InterruptedError, Kyoot, Resource, Result } from "../src/index.ts";

test("suspend resolves through runPromise", async () => {
  const r = await Kyoot.runPromise(Async.suspend<number>((resume) => resume(42)));
  assert.equal(r, 42);
});

test("suspend exposes an AbortSignal from day one", async () => {
  const r = await Kyoot.runPromise(
    Async.suspend((resume, signal: AbortSignal) => resume(signal.aborted)),
  );
  assert.equal(r, false);
});

test("fork/join: a fiber is an independent interpreter loop", async () => {
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(
      Kyoot.gen(function* () {
        yield* Async.sleep(10);
        return "fiber done";
      }),
    );
    return yield* fiber.join;
  });
  assert.equal(await Kyoot.runPromise(prog), "fiber done");
});

test("fiber.await returns a Result instead of throwing", async () => {
  const boom = new Error("boom");
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(
      Async.sleep(1).map(() => {
        throw boom;
      }),
    );
    return yield* fiber.await;
  });
  const r = await Kyoot.runPromise(prog);
  assert.equal(r.ok, false);
  assert.equal(Result.isErr(r) && r.cause._tag, "Defect");
});

test("race: first to complete wins", async () => {
  const slow = Async.sleep(50).map(() => "slow");
  const fast = Async.sleep(5).map(() => "fast");
  assert.equal(await Kyoot.runPromise(Async.race(slow, fast)), "fast");
});

test("timeout: a slow computation fails with a typed TimeoutError", async () => {
  const r = await Kyoot.runPromise(Async.timeout(5, Async.sleep(50)).pipe(Fail.run()));
  assert.equal(r.ok, false);
  assert.ok(
    Result.isErr(r) && r.cause._tag === "Fail" && r.cause.error instanceof Async.TimeoutError,
  );
});

test("timeout: a fast computation wins", async () => {
  const r = await Kyoot.runPromise(
    Async.timeout(
      50,
      Async.sleep(5).map(() => "quick"),
    ).pipe(Fail.orThrow()),
  );
  assert.equal(r, "quick");
});

test("timeout inside a gen resumes the surrounding computation", async () => {
  const prog = Kyoot.gen(function* () {
    const r = yield* Async.timeout(
      50,
      Async.sleep(5).map(() => "quick"),
    ).pipe(Fail.run());
    return r.ok ? `${r.value} again` : "failed";
  });
  assert.equal(await Kyoot.runPromise(prog), "quick again");
});

test("runPromise surfaces defects as rejections", async () => {
  const boom = new Error("boom");
  const k = Kyoot.gen(function* () {
    yield* Async.sleep(1);
    throw boom;
  });
  await assert.rejects(Kyoot.runPromise(k), (e) => e === boom);
});

test("runPromise on an unhandled non-async effect rejects loudly", async () => {
  const k = Fail.fail("still pending");
  await assert.rejects(
    Kyoot.runPromise(k as never),
    (e: unknown) => e instanceof Error && e.message.includes("unhandled effect 'fail'"),
  );
});

test("runSync rejects an async op at runtime", () => {
  assert.throws(
    () => Kyoot.runSync(Async.sleep(1) as never),
    (e: unknown) => e instanceof Error && e.message.includes("unhandled effect 'async'"),
  );
});

test("interrupt: finalizers run and await reports Interrupted", async () => {
  const events: string[] = [];
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(
      Kyoot.gen(function* () {
        yield* Resource.acquire(
          () => "conn",
          () => events.push("release"),
        );
        yield* Async.sleep(10_000);
        return "unreachable";
      }).pipe(Resource.run()),
    );
    yield* fiber.interrupt;
    return yield* fiber.await;
  });
  const r = await Kyoot.runPromise(prog);
  assert.equal(r.ok, false);
  assert.ok(Result.isErr(r) && r.cause._tag === "Interrupted");
  assert.deepEqual(events, ["release"]);
});

test("structured concurrency: a completed parent interrupts its children", async () => {
  const events: string[] = [];
  await Kyoot.runPromise(
    Kyoot.gen(function* () {
      yield* Async.fork(
        Kyoot.gen(function* () {
          yield* Resource.acquire(
            () => "conn",
            () => events.push("release"),
          );
          yield* Async.sleep(10_000);
        }).pipe(Resource.run()),
      );
      return "parent done";
    }),
  );
  assert.deepEqual(events, ["release"]);
});

test("all: results come back in input order, not completion order", async () => {
  const slow = Async.sleep(20).map(() => "slow");
  const fast = Async.sleep(5).map(() => "fast");
  assert.deepEqual(await Kyoot.runPromise(Async.all([slow, fast])), ["slow", "fast"]);
});

test("all: branches run concurrently", async () => {
  const events: string[] = [];
  const branch = (tag: string, ms: number) =>
    Kyoot.gen(function* () {
      events.push(`start ${tag}`);
      yield* Async.sleep(ms);
      events.push(`end ${tag}`);
    });
  await Kyoot.runPromise(Async.all([branch("a", 20), branch("b", 10)]));
  assert.deepEqual(events, ["start a", "start b", "end b", "end a"]);
});

test("all: empty array resolves immediately", async () => {
  assert.deepEqual(await Kyoot.runPromise(Async.all([])), []);
});

test("all: first failure interrupts the rest and runs their finalizers", async () => {
  const events: string[] = [];
  const boom = new Error("boom");
  const slow = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => "conn",
      () => events.push("release"),
    );
    yield* Async.sleep(10_000);
    return "unreachable";
  }).pipe(Resource.run());
  const failing = Async.sleep(5).map(() => {
    throw boom;
  });
  await assert.rejects(Kyoot.runPromise(Async.all([slow, failing])), (e) => e === boom);
  assert.deepEqual(events, ["release"]);
});

test("all: interrupting the parent interrupts every branch", async () => {
  const events: string[] = [];
  const branch = (tag: string) =>
    Kyoot.gen(function* () {
      yield* Resource.acquire(
        () => tag,
        () => events.push(`release ${tag}`),
      );
      yield* Async.sleep(10_000);
    }).pipe(Resource.run());
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(Async.all([branch("a"), branch("b")]));
    yield* Async.sleep(10);
    yield* fiber.interrupt;
    return yield* fiber.await;
  });
  const r = await Kyoot.runPromise(prog);
  assert.equal(r.ok, false);
  assert.ok(Result.isErr(r) && r.cause._tag === "Interrupted");
  assert.deepEqual(events.sort(), ["release a", "release b"]);
});

test("race interrupts the loser and runs its finalizers", async () => {
  const events: string[] = [];
  const slow = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => "slow",
      () => events.push("release slow"),
    );
    yield* Async.sleep(10_000);
    return "slow";
  }).pipe(Resource.run());
  const fast = Async.sleep(5).map(() => "fast");
  const r = await Kyoot.runPromise(Async.race(slow, fast));
  assert.equal(r, "fast");
  assert.deepEqual(events, ["release slow"]);
});

test("timeout interrupts the branch and runs its finalizers", async () => {
  const events: string[] = [];
  const slow = Kyoot.gen(function* () {
    yield* Resource.acquire(
      () => "conn",
      () => events.push("release"),
    );
    yield* Async.sleep(10_000);
    return "unreachable";
  }).pipe(Resource.run());
  const r = await Kyoot.runPromise(Async.timeout(5, slow).pipe(Fail.run()));
  assert.equal(r.ok, false);
  assert.deepEqual(events, ["release"]);
});

test("suspend's signal fires on interruption", async () => {
  let sawAbort = false;
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(
      Async.suspend((_resume, signal: AbortSignal) => {
        signal.addEventListener("abort", () => {
          sawAbort = true;
        });
      }),
    );
    yield* fiber.interrupt;
    yield* fiber.await;
    return sawAbort;
  });
  assert.equal(await Kyoot.runPromise(prog), true);
});

test("joining an interrupted fiber interrupts the joiner", async () => {
  const prog = Kyoot.gen(function* () {
    const fiber = yield* Async.fork(Async.sleep(10_000));
    yield* fiber.interrupt;
    return yield* fiber.join;
  });
  await assert.rejects(Kyoot.runPromise(prog), (e) => e instanceof InterruptedError);
});
