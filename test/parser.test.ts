import assert from "node:assert/strict";
import { test } from "node:test";
import { Kyoot } from "../src/index.ts";
import { evaluate, parseAll, show } from "../examples/parser.ts";

test("parser: a single number has one parse", () => {
  assert.deepEqual(Kyoot.runSync(parseAll("7")), [7]);
});

test("parser: two operands have one parse", () => {
  const parses = Kyoot.runSync(parseAll("1+2"));
  assert.equal(parses.length, 1);
  assert.equal(show(parses[0]!), "(1 + 2)");
});

test("parser: ambiguous precedence enumerates every parenthesization", () => {
  const parses = Kyoot.runSync(parseAll("10-3-2"));
  assert.deepEqual(parses.map(show), ["(10 - (3 - 2))", "((10 - 3) - 2)"]);
  assert.deepEqual(parses.map(evaluate), [9, 5]);
});

test("parser: four operands give the Catalan number of parses", () => {
  const parses = Kyoot.runSync(parseAll("1+2+3+4"));
  assert.equal(parses.length, 5);
  assert.deepEqual([...new Set(parses.map(evaluate))], [10]);
});

test("parser: whitespace is ignored", () => {
  const parses = Kyoot.runSync(parseAll("1 + 2"));
  assert.equal(parses.length, 1);
  assert.equal(evaluate(parses[0]!), 3);
});

test("parser: invalid input is a defect", () => {
  assert.throws(() => Kyoot.runSync(parseAll("1+2x")), /unexpected character 'x'/);
});
