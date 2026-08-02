import assert from "node:assert/strict";
import { test } from "node:test";
import { Abort, Async, Kyoot, Result } from "../src/index.ts";

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
  const r = await Kyoot.runPromise(Async.timeout(5, Async.sleep(50)).pipe(Abort.run()));
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
    ).pipe(Abort.orThrow()),
  );
  assert.equal(r, "quick");
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
  const k = Abort.fail("still pending");
  await assert.rejects(
    Kyoot.runPromise(k as never),
    (e: unknown) => e instanceof Error && e.message.includes("unhandled effect 'abort'"),
  );
});

test("runSync rejects an async op at runtime", () => {
  assert.throws(
    () => Kyoot.runSync(Async.sleep(1) as never),
    (e: unknown) => e instanceof Error && e.message.includes("unhandled effect 'async'"),
  );
});
