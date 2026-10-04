import assert from "node:assert/strict";
import test from "node:test";
import { Async, effect, Kyoot, makeHandler, type EffectRow, type RowsOf } from "../src/index.ts";

const Counter = effect<void, number>()("fork-counter");
const increment = Counter(undefined);

test("same-key declarations with identical contracts interoperate", () => {
  const other = effect<void, number>()("fork-counter");
  assert.equal(Kyoot.runSync(increment.pipe(other.handle({ onOp: (_, resume) => resume(7) }))), 7);
});

test("same continuation contracts compose through handlers and interceptors", () => {
  const NumberSource = effect<void, number>()("source");
  const NumberContinuation = effect<void, number, EffectRow<"source", void, number>>()("number");
  const Same = effect<void, number, EffectRow<"source", void, number>>()("number");
  const source = NumberSource.handle({ onOp: (_, resume) => resume(7) });
  const continued = Same.handle({ onOp: (_, resume) => resume.with(NumberSource(undefined)) });

  const outside = NumberContinuation(undefined).pipe(
    Same.intercept((_, next) => next(undefined)),
    continued,
    source,
  );
  assert.equal(Kyoot.runSync(outside), 7);

  const inside = NumberContinuation(undefined).pipe(source, continued);
  assert.equal(Kyoot.runSync(inside), 7);

  const direct = Same.handler(NumberContinuation(undefined).pipe(source), {
    onOp: (_, resume) => resume.with(NumberSource(undefined)),
  });
  assert.equal(Kyoot.runSync(direct), 7);
});

test("resume.with preserves nested continuation contracts", () => {
  const Source = effect<void, number>()("source");
  const NumberContinuation = effect<void, number, EffectRow<"source", void, number>>()("number");
  const Nested = effect<void, number, RowsOf<ReturnType<typeof NumberContinuation>>>()("nested");
  const program = Nested(undefined).pipe(
    Nested.handle({ onOp: (_, resume) => resume.with(NumberContinuation(undefined)) }),
    NumberContinuation.handle({ onOp: (_, resume) => resume.with(Source(undefined)) }),
    Source.handle({ onOp: (_, resume) => resume(9) }),
  );
  assert.equal(Kyoot.runSync(program), 9);
});

test("raw-key handlers can give a pure answer to differing continuation contracts", () => {
  const Plain = effect<void, number>()("number");
  const NumberContinuation = effect<void, number, EffectRow<"source", void, number>>()("number");
  const Source = effect<void, number>()("source");
  const program = Kyoot.gen(function* () {
    return (yield* Plain(undefined)) + (yield* NumberContinuation(undefined));
  });
  const handled = makeHandler("number", program, {
    onOp: (_, resume) => resume.with(Kyoot.succeed(4)),
  }).pipe(Source.handle({ onOp: (_, resume) => resume(1) }));
  assert.equal(Kyoot.runSync(handled), 8);
});

test("generic handlers retain an undefined payload", () => {
  const maybe = effect<string | undefined, boolean>()("maybe");
  const result = makeHandler("maybe", maybe(undefined), {
    onOp: (payload, resume) => resume(payload === undefined),
  });
  assert.equal(Kyoot.runSync(result), true);
});

test("fork copier runs per sibling and nested child without mutating parent state", async () => {
  const parent = { n: 0 };
  const copies: number[] = [];
  const child = Kyoot.gen(function* () {
    const own = yield* increment;
    const nested = yield* Async.fork(increment);
    return [own, yield* nested.join, yield* increment];
  });
  const program = Kyoot.gen(function* () {
    const before = yield* increment;
    const children = yield* Async.all([child, child]);
    return { before, children, after: yield* increment };
  }).pipe(
    Counter.handle({
      initial: parent,
      fork: (state) => {
        copies.push(state.n);
        return { ...state };
      },
      onOp: (_, resume, state) => resume(++state.n),
    }),
  );
  assert.deepEqual(await Kyoot.runPromise(program), {
    before: 1,
    children: [
      [2, 3, 3],
      [2, 3, 3],
    ],
    after: 2,
  });
  assert.equal(parent.n, 2);
  assert.equal(copies.length, 4);
  assert.deepEqual([...copies].sort(), [1, 1, 2, 2]);
});

test("share intentionally aliases mutable state across siblings and parent", async () => {
  const parent = { n: 0 };
  const program = Kyoot.gen(function* () {
    const children = yield* Async.all([increment, increment]);
    return [children, yield* increment];
  }).pipe(
    Counter.handle({
      initial: parent,
      fork: "share",
      onOp: (_, resume, state) => resume(++state.n),
    }),
  );
  assert.deepEqual(await Kyoot.runPromise(program), [[1, 2], 3]);
  assert.equal(parent.n, 3);
});

test("scope creates fresh child state", async () => {
  let created = 0;
  const program = Kyoot.gen(function* () {
    yield* increment;
    const children = yield* Async.all([increment, increment]);
    return [children, yield* increment];
  }).pipe(
    Counter.handle({
      create: () => (created++, { n: 0 }),
      fork: "scope",
      onOp: (_, resume, state) => resume(++state.n),
    }),
  );
  assert.deepEqual(await Kyoot.runPromise(program), [[1, 1], 2]);
  assert.equal(created, 3);
});

test("matching optional continuation contracts preserve their runtime requirements", () => {
  const S = effect<void, number>()("optional/s");
  const N = effect<void, number, Partial<EffectRow<"optional/s", void, number>>>()("optional/n");
  const value = Kyoot.runSync(
    N(undefined).pipe(
      N.handle({ onOp: (_, resume) => resume.with(S(undefined)) }),
      S.handle({ onOp: (_, resume) => resume(7) }),
    ),
  );
  assert.equal(value, 7);
});
