import assert from "node:assert/strict";
import { test } from "node:test";
import { Kyoot } from "../src/index.ts";
import { liveClock, sleep, testClock } from "../examples/clock.ts";

test("Clock: testClock runs sleeps instantly and tracks virtual time", () => {
  const t0 = Date.now();
  const prog = Kyoot.gen(function* () {
    yield* sleep(30_000);
    yield* sleep(60_000);
    return "done";
  });
  const [result, elapsed] = Kyoot.runSync(prog.pipe(testClock));
  assert.equal(result, "done");
  assert.equal(elapsed, 90_000);
  assert.ok(Date.now() - t0 < 100);
});

test("Clock: testClock state is per-run, not shared", () => {
  const prog = sleep(1_000).map(() => "x");
  assert.deepEqual(Kyoot.runSync(prog.pipe(testClock)), ["x", 1_000]);
  assert.deepEqual(Kyoot.runSync(prog.pipe(testClock)), ["x", 1_000]);
});

test("Clock: liveClock actually sleeps", async () => {
  const t0 = Date.now();
  const result = await Kyoot.runPromise(
    sleep(30)
      .map(() => "slept")
      .pipe(liveClock),
  );
  assert.equal(result, "slept");
  assert.ok(Date.now() - t0 >= 25);
});
