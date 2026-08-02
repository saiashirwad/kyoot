import assert from "node:assert/strict";
import { test } from "node:test";
import { Choice, Kyoot, Var } from "../src/index.ts";

class Count extends Var.Tag<number>()("Count") {}

test("Choice: no choices wraps the single result", () => {
  const prog = Kyoot.gen(function* () {
    return 42;
  });
  assert.deepEqual(Kyoot.runSync(prog.pipe(Choice.run())), [42]);
});

test("Choice: a single choice explores every option in order", () => {
  const prog = Kyoot.gen(function* () {
    const x = yield* Choice.get([1, 2, 3]);
    return x * 10;
  });
  assert.deepEqual(Kyoot.runSync(prog.pipe(Choice.run())), [10, 20, 30]);
});

test("Choice: nested choices are a depth-first cartesian product", () => {
  const prog = Kyoot.gen(function* () {
    const x = yield* Choice.get([1, 2]);
    const y = yield* Choice.get([10, 20]);
    return x + y;
  });
  assert.deepEqual(Kyoot.runSync(prog.pipe(Choice.run())), [11, 21, 12, 22]);
});

test("Choice: empty options drop the branch", () => {
  const prog = Kyoot.gen(function* () {
    const x = yield* Choice.get([1, 2]);
    if (x === 2) yield* Choice.get([]);
    return x;
  });
  assert.deepEqual(Kyoot.runSync(prog.pipe(Choice.run())), [1]);
});

test("Choice: each branch gets an independent Var state", () => {
  const prog = Kyoot.gen(function* () {
    const x = yield* Choice.get([1, 2]);
    yield* Count.update((n) => n + x * 10);
    return x;
  }).pipe(Count.run(0), Choice.run());
  assert.deepEqual(Kyoot.runSync(prog), [
    [1, 10],
    [2, 20],
  ]);
});
