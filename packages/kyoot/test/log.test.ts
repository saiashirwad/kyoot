import assert from "node:assert/strict";
import { test } from "node:test";
import { Kyoot } from "../src/index.ts";
import * as Log from "../src/effects/log.ts";

const prog = Kyoot.gen(function* () {
  yield* Log.info("start");
  yield* Log.warn("careful");
  return 1;
});

test("Log.collect gathers entries in order", () => {
  assert.deepEqual(Kyoot.runSync(prog.pipe(Log.collect)), [
    1,
    [
      { level: "info", message: "start" },
      { level: "warn", message: "careful" },
    ],
  ]);
});

test("Log.discard drops them", () => {
  assert.equal(Kyoot.runSync(prog.pipe(Log.discard)), 1);
});
