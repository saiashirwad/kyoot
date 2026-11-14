import assert from "node:assert/strict";
import { test } from "node:test";
import { Kyoot } from "../src/index.ts";
import * as Fail from "../src/effects/fail.ts";
import { Async, Clock, runPromise } from "../src/async/index.ts";

const boilEgg = (minute: number) =>
  Kyoot.gen(function* () {
    yield* Clock.sleep(1 * minute);
    yield* Clock.sleep(6 * minute);
    return "egg ready";
  });

test("Clock.virtual: sleeps finish at once and add up", () => {
  assert.deepEqual(Kyoot.runSync(boilEgg(60_000).pipe(Clock.virtual)), ["egg ready", 420_000]);
});

test("Clock.virtual: time is per run, not shared", () => {
  const prog = Clock.sleep(1_000).map(() => "x");
  assert.deepEqual(Kyoot.runSync(prog.pipe(Clock.virtual)), ["x", 1_000]);
  assert.deepEqual(Kyoot.runSync(prog.pipe(Clock.virtual)), ["x", 1_000]);
});

test("Clock.live: sleeps for real time under runPromise", async () => {
  const t0 = Date.now();
  assert.equal(await runPromise(boilEgg(5).pipe(Clock.live)), "egg ready");
  assert.ok(Date.now() - t0 >= 30 && Date.now() - t0 < 1_000);
});

test("a nearer virtual clock wins over an outer live one", async () => {
  const r = await runPromise(boilEgg(10_000).pipe(Clock.virtual, Clock.live));
  assert.deepEqual(r, ["egg ready", 70_000]);
});

test("a forked fiber installs its own clock, and interrupt cancels its sleep", async () => {
  const r = await runPromise(
    Kyoot.gen(function* () {
      const fiber = yield* Async.fork(Clock.sleep(10_000).pipe(Clock.live));
      yield* Async.interrupt(fiber);
      return yield* Async.wait(fiber);
    }),
  );
  assert.equal(r.ok, false);
});

const nap = (ms: number) => Clock.sleep(ms).map(() => "done" as const);

test("Clock.test: sleeps wait for advance and time is shared with forks", async () => {
  const clock = Clock.test();
  const seen: string[] = [];
  const p = runPromise(
    Kyoot.gen(function* () {
      const f = yield* Async.fork(
        nap(20).map(() => seen.push("child")),
        { provide: (k) => k.pipe(clock.handler) },
      );
      yield* nap(10);
      seen.push("parent");
      yield* Async.join(f);
    }).pipe(Fail.orThrow, clock.handler),
  );
  await clock.advance(10);
  assert.deepEqual(seen, ["parent"]);
  assert.equal(clock.now, 10);
  await clock.advance(10);
  await p;
  assert.deepEqual(seen, ["parent", "child"]);
  assert.equal(clock.now, 20);
});

test("Clock.test: a woken fiber that sleeps again inside the window is woken too", async () => {
  const clock = Clock.test();
  const p = runPromise(
    Kyoot.gen(function* () {
      yield* Clock.sleep(5);
      yield* Clock.sleep(5);
      return "x";
    }).pipe(clock.handler),
  );
  await clock.advance(10);
  assert.equal(await p, "x");
});

test("timeout with Clock.test: fires without real waiting", async () => {
  const clock = Clock.test();
  const p = runPromise(
    Async.timeout(1_000_000, nap(2_000_000), { provide: (k) => k.pipe(clock.handler) }).pipe(
      Fail.run,
    ),
  );
  await clock.advance(1_000_000);
  const r = await p;
  assert.ok(!r.ok && r.cause._tag === "Fail" && r.cause.error instanceof Async.Timeout);
});

test("timeout with Clock.test: the fast path wins", async () => {
  const clock = Clock.test();
  const p = runPromise(
    Async.timeout(1_000, nap(10), { provide: (k) => k.pipe(clock.handler) }).pipe(Fail.orThrow),
  );
  await clock.advance(10);
  assert.equal(await p, "done");
});

test("timeout's sleep goes through the provided clock, so intercepts see it", async () => {
  const seen: number[] = [];
  const clock = Clock.test();
  const spy = Clock.intercept((ms, next) => (seen.push(ms), next(ms)));
  const p = runPromise(
    Async.timeout(40, nap(10_000), { provide: (k) => k.pipe(spy, clock.handler) }).pipe(Fail.run),
  );
  await clock.advance(40);
  const r = await p;
  assert.deepEqual(
    seen.sort((a, b) => a - b),
    [40, 10_000],
  );
  assert.ok(!r.ok);
});
