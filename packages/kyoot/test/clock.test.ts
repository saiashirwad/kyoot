import assert from "node:assert/strict";
import { test } from "node:test";
import { Async, Clock, Kyoot } from "../src/index.ts";

const boilEgg = (minute: number) =>
  Kyoot.gen(function* () {
    yield* Clock.sleep(1 * minute);
    yield* Clock.sleep(6 * minute);
    return "egg ready";
  });

test("Clock.virtual: sleeps finish at once and add up", () => {
  const t0 = Date.now();
  assert.deepEqual(Kyoot.runSync(boilEgg(60_000).pipe(Clock.virtual)), ["egg ready", 420_000]);
  assert.ok(Date.now() - t0 < 100);
});

test("Clock.virtual: time is per run, not shared", () => {
  const prog = Clock.sleep(1_000).map(() => "x");
  assert.deepEqual(Kyoot.runSync(prog.pipe(Clock.virtual)), ["x", 1_000]);
  assert.deepEqual(Kyoot.runSync(prog.pipe(Clock.virtual)), ["x", 1_000]);
});

test("runPromise serves the clock with real time", async () => {
  const t0 = Date.now();
  assert.equal(await Kyoot.runPromise(boilEgg(5)), "egg ready");
  assert.ok(Date.now() - t0 >= 30);
});

test("a nearer virtual clock wins over the driver's real one", async () => {
  const t0 = Date.now();
  const r = await Kyoot.runPromise(boilEgg(10_000).pipe(Clock.virtual));
  assert.deepEqual(r, ["egg ready", 70_000]);
  assert.ok(Date.now() - t0 < 100);
});

test("a forked fiber gets the real clock, and interrupt cancels its sleep", async () => {
  const t0 = Date.now();
  const r = await Kyoot.runPromise(
    Kyoot.gen(function* () {
      const fiber = yield* Async.fork(Clock.sleep(10_000));
      yield* fiber.interrupt;
      return yield* fiber.await;
    }),
  );
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 1_000);
});
