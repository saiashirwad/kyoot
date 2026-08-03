import assert from "node:assert/strict";
import { test } from "node:test";
import { Kyoot, Result } from "../src/index.ts";
import {
  ParseError,
  char,
  digit,
  endOfInput,
  error,
  many,
  oneOf,
  optional,
  or,
  parse,
  regex,
  sepBy,
  string,
} from "../parser/index.ts";
import type { Parser } from "../parser/index.ts";

class OutOfRange {
  readonly _tag = "OutOfRange";
  readonly n: number;
  constructor(n: number) {
    this.n = n;
  }
}

const byte: Parser<number, OutOfRange> = Kyoot.gen(function* () {
  const digits = yield* many(digit, { atLeast: 1 });
  const n = Number(digits.join(""));
  if (n > 255) return yield* error(new OutOfRange(n));
  return n;
});

const failPayload = <E, A>(r: Result<E, A>): E => {
  assert.ok(Result.isErr(r));
  assert.equal(r.cause._tag, "Fail");
  return (r.cause as { error: E }).error;
};

test("parse: success returns the value", () => {
  const r = parse(
    "hello",
    string("hello").pipe((k) => k.map((s) => s.toUpperCase())),
  );
  assert.deepEqual(r, { ok: true, value: "HELLO" });
});

test("parse: failure reports position, expected, found", () => {
  const p = Kyoot.gen(function* () {
    yield* many(digit, { atLeast: 1 });
    yield* endOfInput;
  });
  const e = failPayload(parse("1a2", p));
  assert.ok(e instanceof ParseError);
  assert.equal(e.format("1a2"), 'line 1, column 2: expected end of input, found "a"');
});

test("or: backtracks after consumed input", () => {
  const p = or(string("ab"), string("ac"));
  assert.deepEqual(parse("ac", p), { ok: true, value: "ac" });
});

test("or: when both branches fail, the farthest error wins", () => {
  const p = oneOf([string("hello"), string("help")]);
  const e = failPayload(parse("helx", p));
  assert.ok(e instanceof ParseError);
  assert.equal(e.pos, 3);
});

test("domain errors are typed in the row and committed (no backtracking)", () => {
  const p = or(byte, string("n/a"));
  const e = failPayload(parse("300", p));
  assert.ok(e instanceof OutOfRange);
  assert.equal(e.n, 300);
});

test("domain errors merge into the error union", () => {
  const r: Result<ParseError | OutOfRange, number> = parse("42", byte);
  assert.deepEqual(r, { ok: true, value: 42 });
});

test("many: atLeast enforces a minimum", () => {
  const e = failPayload(parse("abc", many(digit, { atLeast: 1 })));
  assert.ok(e instanceof ParseError);
  assert.equal(e.pos, 0);
});

test("optional: succeeds without consuming on mismatch", () => {
  const p = Kyoot.gen(function* () {
    const sign = yield* optional(char("-"));
    const digits = yield* many(digit, { atLeast: 1 });
    return (sign ?? "") + digits.join("");
  });
  assert.deepEqual(parse("-42", p), { ok: true, value: "-42" });
  assert.deepEqual(parse("42", p), { ok: true, value: "42" });
});

test("regex: matches at the current position and advances", () => {
  const p = Kyoot.gen(function* () {
    const word = yield* regex(/[a-z]+/, "word");
    yield* char("-");
    return word;
  });
  assert.deepEqual(parse("abc-def", p), { ok: true, value: "abc" });
  const e = failPayload(parse("123", regex(/[a-z]+/, "word")));
  assert.ok(e instanceof ParseError);
});

test("sepBy: parses comma-separated values", () => {
  const r = parse("1,22,333", sepBy(regex(/[0-9]+/, "number"), char(",")));
  assert.deepEqual(r, { ok: true, value: ["1", "22", "333"] });
  assert.deepEqual(parse("", sepBy(digit, char(","))), { ok: true, value: [] });
});

test("parse: state is fresh across runs", () => {
  const p = string("ab");
  assert.deepEqual(parse("ab", p), { ok: true, value: "ab" });
  assert.deepEqual(parse("ab", p), { ok: true, value: "ab" });
});
