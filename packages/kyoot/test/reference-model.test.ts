import assert from "node:assert/strict";
import { test } from "node:test";
import { effect, Fail, Kyoot, type Kyoot as Program } from "../src/index.ts";

/**
 * A deliberately small, executable model of the synchronous part of Kyoot.
 *
 * It is intentionally not an implementation of Machine: programs are a tiny
 * data language and `evaluate` is a direct recursive evaluator.  The same
 * data is compiled to Kyoot below, so a mismatch catches changes in the
 * observable continuation/handler behaviour rather than repeating Machine.
 */
type Expr =
  | { readonly tag: "pure"; readonly value: number }
  | { readonly tag: "map"; readonly source: Expr; readonly by: number }
  | { readonly tag: "flatMap"; readonly source: Expr; readonly next: Next }
  | { readonly tag: "ask"; readonly value: number }
  | { readonly tag: "fail"; readonly error: number }
  | { readonly tag: "gen"; readonly steps: readonly Expr[] };

type Next =
  | { readonly tag: "add"; readonly by: number }
  | { readonly tag: "ask"; readonly by: number }
  | { readonly tag: "fail"; readonly by: number };

type Exit =
  | { readonly tag: "value"; readonly value: number }
  | { readonly tag: "failure"; readonly error: number }
  | { readonly tag: "dropped"; readonly value: number };

type Observation = {
  readonly result:
    | { readonly ok: true; readonly value: number }
    | {
        readonly ok: false;
        readonly error: number;
      };
  readonly order: readonly string[];
};

const Ask = effect<number, number>()("reference/ask");

const apply = (next: Next, value: number): Expr => {
  switch (next.tag) {
    case "add":
      return { tag: "pure", value: value + next.by };
    case "ask":
      return { tag: "ask", value: value + next.by };
    case "fail":
      return { tag: "fail", error: value + next.by };
  }
};

const evaluate = (expr: Expr, order: string[]): Exit => {
  switch (expr.tag) {
    case "pure":
      return { tag: "value", value: expr.value };
    case "map": {
      const source = evaluate(expr.source, order);
      return source.tag === "value" ? { tag: "value", value: source.value + expr.by } : source;
    }
    case "flatMap": {
      const source = evaluate(expr.source, order);
      return source.tag === "value" ? evaluate(apply(expr.next, source.value), order) : source;
    }
    case "ask":
      order.push(`ask ${expr.value}`);
      // This is the only operation handler in the model. Multiples of five
      // deliberately drop their continuation, which makes the law observable.
      return expr.value % 5 === 0
        ? { tag: "dropped", value: 1_000 + expr.value }
        : { tag: "value", value: expr.value * 2 };
    case "fail":
      return { tag: "failure", error: expr.error };
    case "gen": {
      let total = 0;
      for (const step of expr.steps) {
        const result = evaluate(step, order);
        if (result.tag !== "value") return result;
        total += result.value;
      }
      return { tag: "value", value: total };
    }
  }
};

const reference = (expr: Expr): Observation => {
  const order: string[] = [];
  const exit = evaluate(expr, order);
  return {
    result:
      exit.tag === "failure" ? { ok: false, error: exit.error } : { ok: true, value: exit.value },
    order,
  };
};

// The reference language has only the two effects handled by `machine` below.
// Keeping this boundary erased lets the test focus on runtime equivalence.
const compile = (expr: Expr): Program<number, {}> => {
  switch (expr.tag) {
    case "pure":
      return Kyoot.succeed(expr.value);
    case "map":
      return compile(expr.source).map((value) => value + expr.by);
    case "flatMap":
      return compile(expr.source).flatMap((value) => compile(apply(expr.next, value)));
    case "ask":
      return Ask(expr.value) as Program<number, {}>;
    case "fail":
      return Fail.fail(expr.error) as unknown as Program<number, {}>;
    case "gen":
      return Kyoot.gen(function* () {
        let total = 0;
        for (const step of expr.steps) total += yield* compile(step);
        return total;
      }) as Program<number, {}>;
  }
};

const machine = (expr: Expr): Observation => {
  const order: string[] = [];
  const result = Kyoot.runSync(
    compile(expr).pipe(
      Ask.handle({
        onOp: (value, resume) => {
          order.push(`ask ${value}`);
          return value % 5 === 0 ? Kyoot.succeed(1_000 + value) : resume(value * 2);
        },
      }),
      Fail.run,
    ),
  );
  if (result.ok) return { result: { ok: true, value: result.value }, order };
  if (result.cause._tag === "Fail") {
    return { result: { ok: false, error: result.cause.error as number }, order };
  }
  throw new Error(`reference programs cannot defect: ${result.cause._tag}`);
};

const show = (expr: Expr): string => JSON.stringify(expr);

const random = (seed: number) => {
  let state = seed | 0;
  return (limit: number): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % limit;
  };
};

const generated = (seed: number, depth: number): Expr => {
  const next = random(seed);
  const build = (remaining: number): Expr => {
    if (remaining === 0) {
      const leaf = next(3);
      return leaf === 0
        ? { tag: "pure", value: next(12) }
        : leaf === 1
          ? { tag: "ask", value: next(12) + 1 }
          : { tag: "fail", error: next(12) + 1 };
    }
    switch (next(6)) {
      case 0:
        return { tag: "pure", value: next(20) };
      case 1:
        return { tag: "ask", value: next(15) + 1 };
      case 2:
        return { tag: "fail", error: next(20) + 1 };
      case 3:
        return { tag: "map", source: build(remaining - 1), by: next(9) - 4 };
      case 4: {
        const tag = next(3);
        const nextStep: Next =
          tag === 0
            ? { tag: "add", by: next(9) - 4 }
            : tag === 1
              ? { tag: "ask", by: next(6) }
              : { tag: "fail", by: next(6) };
        return { tag: "flatMap", source: build(remaining - 1), next: nextStep };
      }
      default:
        return { tag: "gen", steps: [build(remaining - 1), build(remaining - 1)] };
    }
  };
  return build(depth);
};

test("reference model agrees with Machine for seeded synchronous programs", () => {
  for (let seed = 1; seed <= 24; seed++) {
    for (let depth = 0; depth <= 4; depth++) {
      const program = generated(seed * 101 + depth, depth);
      assert.deepEqual(
        machine(program),
        reference(program),
        `seed=${seed}, depth=${depth}: ${show(program)}`,
      );
    }
  }
});

test("reference model pins failure handling and a dropped continuation", () => {
  const typedFailure: Expr = {
    tag: "flatMap",
    source: { tag: "ask", value: 3 },
    next: { tag: "fail", by: 4 },
  };
  const dropped: Expr = {
    tag: "flatMap",
    source: { tag: "ask", value: 5 },
    next: { tag: "add", by: 999 },
  };

  assert.deepEqual(machine(typedFailure), reference(typedFailure));
  assert.deepEqual(machine(dropped), reference(dropped));
  assert.deepEqual(machine(dropped), {
    result: { ok: true, value: 1_005 },
    order: ["ask 5"],
  });
});
