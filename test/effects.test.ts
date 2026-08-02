import assert from "node:assert/strict";
import { test } from "node:test";
import { Emit, Env, Kyoot, Sync, Var } from "../src/index.ts";

test("Env: provide answers the service key", () => {
  interface Greeter {
    greet(name: string): string;
  }
  const Greeter = Env.service<Greeter>()("greeter");
  const prog = Kyoot.gen(function* () {
    const g = yield* Greeter;
    return g.greet("kyo");
  });
  const r = Kyoot.runSync(prog.pipe(Env.provide("greeter", { greet: (n: string) => `hi ${n}` })));
  assert.equal(r, "hi kyo");
});

test("Env: multiple services get distinct keys", () => {
  const A = Env.service<{ a: number }>()("a");
  const B = Env.service<{ b: number }>()("b");
  const prog = Kyoot.gen(function* () {
    const { a } = yield* A;
    const { b } = yield* B;
    return a + b;
  });
  const r = Kyoot.runSync(prog.pipe(Env.provide("a", { a: 1 }), Env.provide("b", { b: 2 })));
  assert.equal(r, 3);
});

test("Var: get/set/update", () => {
  const prog = Kyoot.gen(function* () {
    yield* Var.set(1);
    yield* Var.update<number>((v) => v + 1);
    return yield* Var.get<number>();
  });
  assert.deepEqual(Kyoot.runSync(prog.pipe(Var.run(0))), [2, 2]);
});

test("Emit.run collects everything emitted", () => {
  const prog = Kyoot.gen(function* () {
    yield* Emit.value("a");
    yield* Emit.value("b");
    return 7;
  });
  assert.deepEqual(Kyoot.runSync(prog.pipe(Emit.run())), [7, ["a", "b"]]);
});

test("Emit.forEach consumes values as they happen", () => {
  const seen: string[] = [];
  const prog = Kyoot.gen(function* () {
    yield* Emit.value("x");
    yield* Emit.value("y");
    return "done";
  });
  const r = Kyoot.runSync(prog.pipe(Emit.forEach((e: string) => seen.push(e))));
  assert.equal(r, "done");
  assert.deepEqual(seen, ["x", "y"]);
});

test("Emit.discard drops the stream", () => {
  const prog = Kyoot.gen(function* () {
    yield* Emit.value(1);
    return "ok";
  });
  assert.equal(Kyoot.runSync(prog.pipe(Emit.discard())), "ok");
});

test("Sync.defer is lazy and Sync.run discharges it", () => {
  let calls = 0;
  const prog = Kyoot.gen(function* () {
    const a = yield* Sync.defer(() => {
      calls++;
      return 3;
    });
    return a * 2;
  });
  assert.equal(calls, 0);
  const r = Kyoot.runSync(prog.pipe(Sync.run()));
  assert.equal(r, 6);
  assert.equal(calls, 1);
});

test("Sync.defer: a throwing thunk is a defect, not a typed failure", () => {
  const boom = new Error("boom");
  const prog = Sync.defer(() => {
    throw boom;
  });
  assert.throws(
    () => Kyoot.runSync(prog.pipe(Sync.run())),
    (e) => e === boom,
  );
});
