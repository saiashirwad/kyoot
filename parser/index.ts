import { Fail, Kyoot, Result, effect, succeed } from "../src/index.ts";
import type { AnyKyoot, Kyoot as KyootT, Merge, Row, Simplify } from "../src/index.ts";

export class ParseError {
  readonly _tag = "ParseError";
  readonly pos: number;
  readonly expected: string;
  readonly found: string | undefined;

  constructor(pos: number, expected: string, found: string | undefined) {
    this.pos = pos;
    this.expected = expected;
    this.found = found;
  }

  format(source: string): string {
    const before = source.slice(0, this.pos);
    const line = before.split("\n").length;
    const col = this.pos - before.lastIndexOf("\n");
    const found = this.found === undefined ? "end of input" : JSON.stringify(this.found);
    return `line ${line}, column ${col}: expected ${this.expected}, found ${found}`;
  }
}

export type Parser<A, E = never> = KyootT<
  A,
  { "parse/input": void; "parse/fail": ParseError } & ([E] extends [never] ? {} : { fail: E })
>;

type DomainError<S> = "fail" extends keyof S ? S["fail"] : never;

type InputOp =
  | { readonly kind: "next" }
  | { readonly kind: "peek" }
  | { readonly kind: "rest" }
  | { readonly kind: "pos" }
  | { readonly kind: "seek"; readonly pos: number };

const Input = effect<"parse/input", void, InputOp>("parse/input");

const next = Input.op<string | undefined>({ kind: "next" });
const peek = Input.op<string | undefined>({ kind: "peek" });
const restSlice = Input.op<string>({ kind: "rest" });
const getPos = Input.op<number>({ kind: "pos" });
const seek = (pos: number) => Input.op<void>({ kind: "seek", pos });

const ParseFail = effect<"parse/fail", ParseError>("parse/fail");

const parseFail = (e: ParseError): KyootT<never, { "parse/fail": ParseError }> =>
  ParseFail.op<never>(e);

const catchParse = <A2, S2 extends Row>(f: (e: ParseError) => KyootT<A2, S2>) => {
  const handle = ParseFail.handle({
    onOp: (e) => f(e) as AnyKyoot,
    onSuccess: (a) => succeed(a),
  });
  return <A, S extends Row & { "parse/fail"?: ParseError } = {}>(
    k: KyootT<A, S>,
  ): KyootT<A | A2, Simplify<Merge<Omit<S, "parse/fail">, S2>>> =>
    handle(k as AnyKyoot) as KyootT<A | A2, Simplify<Merge<Omit<S, "parse/fail">, S2>>>;
};

const input = (source: string) => {
  const handle = Input.handle<number>({
    state: 0,
    onOp: (op, resume, pos) => {
      switch (op.kind) {
        case "next":
          return resume(source[pos], pos + 1);
        case "peek":
          return resume(source[pos], pos);
        case "rest":
          return resume(source.slice(pos), pos);
        case "pos":
          return resume(pos, pos);
        case "seek":
          return resume(undefined, op.pos);
      }
    },
    onSuccess: (a) => succeed(a),
  });
  return <A, S extends Row & { "parse/input"?: void } = {}>(k: KyootT<A, S>) => handle<A, S, A>(k);
};

const parseErrors = () => {
  const handle = ParseFail.handle({
    onOp: (e) => succeed(Result.fail(e)),
    onSuccess: (a) => succeed(Result.ok(a)),
  });
  return <A, S extends Row & { "parse/fail"?: ParseError } = {}>(k: KyootT<A, S>) =>
    handle<A, S, Result<ParseError, A>>(k);
};

export function parse<A, S extends Row & { "parse/input": void; "parse/fail"?: ParseError }>(
  source: string,
  parser: KyootT<A, S>,
): Result<ParseError | DomainError<S>, A> {
  const r = Kyoot.runSync(
    parser.pipe(input(source), parseErrors(), Fail.run()) as KyootT<
      Result<DomainError<S>, Result<ParseError, A>>,
      {}
    >,
  );
  return r.ok ? r.value : r;
}

export const error = <E>(e: E): KyootT<never, { fail: E }> => Fail.fail(e);

const expectedHere = (expected: string) =>
  Kyoot.gen(function* () {
    const pos = yield* getPos;
    const found = yield* peek;
    return yield* parseFail(new ParseError(pos, expected, found));
  });

export const satisfy = (pred: (c: string) => boolean, expected: string): Parser<string> =>
  Kyoot.gen(function* () {
    const c = yield* peek;
    if (c === undefined || !pred(c)) return yield* expectedHere(expected);
    return yield* next;
  }) as Parser<string>;

export const char = (c: string) => satisfy((x) => x === c, JSON.stringify(c));

export const digit = satisfy((c) => c >= "0" && c <= "9", "digit");

export const letter: Parser<string> = satisfy(
  (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z"),
  "letter",
);

export const string = (s: string): Parser<string> =>
  Kyoot.gen(function* () {
    for (const c of s) yield* char(c);
    return s;
  }) as Parser<string>;

export const regex = (re: RegExp, expected: string): Parser<string> =>
  Kyoot.gen(function* () {
    const pos = yield* getPos;
    const m = re.exec(yield* restSlice);
    if (m === null || m.index !== 0) return yield* expectedHere(expected);
    yield* seek(pos + m[0].length);
    return m[0];
  }) as Parser<string>;

export const endOfInput: Parser<void> = Kyoot.gen(function* () {
  const c = yield* peek;
  if (c !== undefined) return yield* expectedHere("end of input");
}) as Parser<void>;

const or2 = (p: Parser<any, any>, q: Parser<any, any>): AnyKyoot =>
  Kyoot.gen(function* () {
    const mark = yield* getPos;
    return yield* p.pipe(
      catchParse((e1) =>
        Kyoot.gen(function* () {
          yield* seek(mark);
          return yield* (q as AnyKyoot).pipe(
            catchParse((e2) => parseFail(e2.pos >= e1.pos ? e2 : e1)),
          );
        }),
      ),
    );
  });

export function or<A, E1, B, E2>(p: Parser<A, E1>, q: Parser<B, E2>): Parser<A | B, E1 | E2> {
  return or2(p, q) as Parser<A | B, E1 | E2>;
}

export const oneOf = <A, E>(ps: ReadonlyArray<Parser<A, E>>): Parser<A, E> => {
  let acc: AnyKyoot = parseFail(new ParseError(0, "one of", undefined));
  for (let i = ps.length - 1; i >= 0; i--) acc = or2(ps[i]!, acc);
  return acc as Parser<A, E>;
};

export const many = <A, E>(p: Parser<A, E>, opts?: { atLeast?: number }): Parser<A[], E> =>
  Kyoot.gen(function* () {
    const out: A[] = [];
    const atLeast = opts?.atLeast ?? 0;
    for (let i = 0; i < atLeast; i++) out.push(yield* p);
    while (true) {
      const r = yield* or2(
        p.map((a): { readonly more: true; readonly a: A } => ({ more: true, a })) as AnyKyoot,
        succeed({ more: false } as const),
      );
      if (!r.more) return out;
      out.push(r.a);
    }
  }) as Parser<A[], E>;

export const optional = <A, E>(p: Parser<A, E>) =>
  or2(p as Parser<any, any>, succeed(undefined)) as Parser<A | undefined, E>;

export const sepBy = <A, E>(p: Parser<A, E>, sep: Parser<unknown, E>) =>
  Kyoot.gen(function* () {
    const first = yield* optional(p);
    if (first === undefined) return [] as A[];
    const restItems = yield* many(
      Kyoot.gen(function* () {
        yield* sep;
        return yield* p;
      }) as Parser<A, E>,
    );
    return [first, ...restItems];
  }) as Parser<A[], E>;
