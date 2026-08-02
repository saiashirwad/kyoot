import assert from "node:assert/strict";
import { test } from "node:test";
import { Abort, Kyoot, Result, Var } from "../src/index.ts";

class Total extends Var.Tag<number>()("Total") {}

test("Abort.run: success becomes Result.ok", () => {
  const prog = Kyoot.gen(function* () {
    if (false) yield* Abort.fail("never");
    return 42;
  });
  const r = Kyoot.runSync(prog.pipe(Abort.run()));
  assert.deepEqual(r, { ok: true, value: 42 });
});

test("Abort.run: typed failure becomes Result with a Fail cause", () => {
  const r = Kyoot.runSync(Abort.fail("nope").pipe(Abort.run()));
  assert.deepEqual(r, { ok: false, cause: { _tag: "Fail", error: "nope" } });
});

test("Abort.run: a defect lands in the defect channel, not the error channel", () => {
  const boom = new Error("boom");
  const k = Kyoot.gen(function* () {
    yield* Kyoot.succeed(1);
    throw boom;
  }).pipe(Abort.run());
  const r = Kyoot.runSync(k);
  assert.equal(r.ok, false);
  assert.equal(Result.isErr(r) && r.cause._tag, "Defect");
  assert.equal(Result.isErr(r) && r.cause._tag === "Defect" && r.cause.defect, boom);
});

test("defects bypass Abort.catchAll", () => {
  const boom = new Error("boom");
  const k = Kyoot.succeed(1)
    .map(() => {
      throw boom;
    })
    .pipe(Abort.catchAll(() => Kyoot.succeed("recovered")));
  assert.throws(
    () => Kyoot.runSync(k),
    (e) => e === boom,
  );
});

test("Abort.catchAll replaces a typed failure with a new computation", () => {
  const k = Kyoot.gen(function* () {
    yield* Abort.fail("bad");
    return "unreachable";
  }).pipe(Abort.catchAll((e: string) => Kyoot.succeed(`caught ${e}`)));
  assert.equal(Kyoot.runSync(k), "caught bad");
});

test("Abort.orThrow throws the error value at the edge", () => {
  const err = new RangeError("too big");
  assert.throws(
    () => Kyoot.runSync(Abort.fail(err).pipe(Abort.orThrow())),
    (e) => e === err,
  );
});

test("handler order: Var before Abort is transactional — failure carries no state", () => {
  const prog = Kyoot.gen(function* () {
    yield* Total.update((t) => t + 10);
    yield* Abort.fail("out of stock");
    return "unreachable";
  });
  const r = Kyoot.runSync(prog.pipe(Total.run(0), Abort.run()));
  assert.equal(r.ok, false);
});

test("handler order: Abort before Var — state survives failure", () => {
  const prog = Kyoot.gen(function* () {
    yield* Total.update((t) => t + 10);
    yield* Abort.fail("out of stock");
    return "unreachable";
  });
  const [r, state] = Kyoot.runSync(prog.pipe(Abort.run(), Total.run(0)));
  assert.equal(r.ok, false);
  assert.equal(state, 10);
});
