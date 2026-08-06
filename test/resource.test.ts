import assert from "node:assert/strict";
import { test } from "node:test";
import { Fail, Kyoot, Resource } from "../src/index.ts";

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
  assert.equal(Kyoot.runSync(prog.pipe(Resource.run())), "done");
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
  Kyoot.runSync(prog.pipe(Resource.run()));
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
  }).pipe(Fail.run(), Resource.run());
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
  }).pipe(Resource.run());
  assert.throws(
    () => Kyoot.runSync(prog),
    (e) => e === boom,
  );
  assert.deepEqual(events, ["release"]);
});
