import assert from "node:assert/strict";
import { test } from "node:test";
import { drive } from "../examples/step.ts";
import { effect, ensuring, Kyoot, Sync, Var } from "../src/index.ts";

const Ask = effect<string, number>()("ask");
const Tidy = effect<string, void>()("tidy");

const pending = <T extends { readonly done: boolean }>(step: T) => {
  assert.equal(step.done, false);
  return step as Extract<T, { readonly done: false }>;
};

test("step: a program with nothing left to handle is done at once", () => {
  assert.deepEqual(Kyoot.step(Kyoot.succeed(1)), { done: true, value: 1 });
  const Count = Var.tag<number>()("count");
  const counted = Count.update((n) => n + 1).pipe(Count.run(1));
  assert.deepEqual(Kyoot.step(counted), { done: true, value: [undefined, 2] });
});

test("step: a pending step names the effect, and resume answers it", () => {
  const sum = Kyoot.gen(function* () {
    return (yield* Ask("a")) + (yield* Ask("b"));
  });
  const first = pending(Kyoot.step(sum));
  assert.deepEqual([first.key, first.payload], ["ask", "a"]);
  const second = pending(first.resume(1));
  assert.deepEqual([second.key, second.payload], ["ask", "b"]);
  assert.deepEqual(second.resume(2), { done: true, value: 3 });
});

test("step: handlers inside the program keep their state across suspensions", () => {
  const Count = Var.tag<number>()("count");
  const program = Kyoot.gen(function* () {
    yield* Count.set(yield* Ask("first"));
    yield* Count.update((n) => n + 1);
    return yield* Ask("second");
  }).pipe(Count.run(0));
  const result = pending(pending(Kyoot.step(program)).resume(41)).resume(7);
  assert.deepEqual(result, { done: true, value: [7, 42] });
});

test("step: a used step throws instead of running the program twice", () => {
  const runs: number[] = [];
  const first = pending(Kyoot.step(Ask("n").map((n) => runs.push(n))));
  first.resume(1);
  assert.throws(() => first.resume(2), /step already used/);
  assert.throws(() => first.raise(new Error("late")), /step already used/);
  assert.throws(() => first.cancel(), /step already used/);
  assert.deepEqual(runs, [1]);
});

test("step: a finished step has nothing to resume", () => {
  const done = pending(Kyoot.step(Ask("n"))).resume(1);
  assert.deepEqual(Object.keys(done), ["done", "value"]);
});

test("step: raise throws at the operation, where the program can catch it", () => {
  const boom = new Error("boom");
  const program = Kyoot.gen(function* () {
    try {
      return yield* Ask("n");
    } catch (error) {
      return error;
    }
  });
  assert.deepEqual(pending(Kyoot.step(program)).raise(boom), { done: true, value: boom });
});

test("step: an error the program does not catch leaves through the driver", () => {
  const boom = new Error("boom");
  const events: string[] = [];
  const program = ensuring(Ask("n"), Sync.defer(() => events.push("cleanup")).pipe(Sync.run));
  assert.throws(
    () => pending(Kyoot.step(program)).raise(boom),
    (e) => e === boom,
  );
  assert.deepEqual(events, ["cleanup"]);
});

test("step: cancel runs finally blocks and ensuring, innermost first", () => {
  const events: string[] = [];
  const inner = Kyoot.gen(function* () {
    try {
      return yield* Ask("n");
    } finally {
      events.push("finally");
    }
  });
  const program = ensuring(inner, Sync.defer(() => events.push("ensuring")).pipe(Sync.run));
  assert.deepEqual(pending(Kyoot.step(program)).cancel(), { done: true, value: undefined });
  assert.deepEqual(events, ["finally", "ensuring"]);
});

test("step: cleanup that performs an effect suspends the cancel for the driver to answer", () => {
  const events: string[] = [];
  const program = Kyoot.gen(function* () {
    try {
      return yield* Ask("n");
    } finally {
      yield* Tidy("socket");
      events.push("tidied");
    }
  });
  const cleanup = pending(pending(Kyoot.step(program)).cancel());
  assert.deepEqual([cleanup.key, cleanup.payload], ["tidy", "socket"]);
  assert.deepEqual(events, []);
  assert.ok(cleanup.key === "tidy");
  assert.deepEqual(cleanup.resume(undefined), { done: true, value: undefined });
  assert.deepEqual(events, ["tidied"]);
});

test("step: disposing a pending step cancels it", () => {
  const events: string[] = [];
  const program = Kyoot.gen(function* () {
    try {
      return yield* Ask("n");
    } finally {
      events.push("finally");
    }
  });
  pending(Kyoot.step(program))[Symbol.dispose]();
  assert.deepEqual(events, ["finally"]);
});

test("step: disposing abandons cleanup that waits on an effect, and still closes the rest", () => {
  const events: string[] = [];
  const inner = Kyoot.gen(function* () {
    try {
      return yield* Ask("n");
    } finally {
      events.push("inner");
      yield* Tidy("socket");
      events.push("unreachable");
    }
  });
  const program = Kyoot.gen(function* () {
    try {
      return yield* inner;
    } finally {
      events.push("outer");
    }
  });
  pending(Kyoot.step(program))[Symbol.dispose]();
  assert.deepEqual(events, ["inner", "outer"]);
});

test("step: disposing a used step does nothing", () => {
  const events: string[] = [];
  const first = pending(
    Kyoot.step(ensuring(Ask("n"), Sync.defer(() => events.push("cleanup")).pipe(Sync.run))),
  );
  assert.deepEqual(first.resume(1), { done: true, value: 1 });
  first[Symbol.dispose]();
  assert.deepEqual(events, ["cleanup"]);
});

test("step example: an outside driver feeds events into a program that asks for them", () => {
  const log: string[] = [];
  const bought = drive(
    [{ type: "add", sku: "book" }, { type: "add", sku: "pen" }, { type: "pay" }, { type: "paid" }],
    log,
  );
  assert.equal(bought, "paid for book, pen");
  assert.deepEqual(log, ["closed"]);
});

test("step example: a handler above the states sees every event first", () => {
  const log: string[] = [];
  assert.equal(
    drive([{ type: "add", sku: "book" }, { type: "cancel" }, { type: "pay" }], log),
    "cancelled",
  );
  assert.deepEqual(log, ["closed"]);
});

test("step example: running out of events cancels the program and runs its cleanup", () => {
  const log: string[] = [];
  assert.equal(drive([{ type: "add", sku: "book" }], log), "abandoned");
  assert.deepEqual(log, ["closed"]);
});
