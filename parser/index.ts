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

type ParserBase = { "parse/input": void; "parse/fail": ParseError };

type ParserRow = Row & ParserBase;

type FailRow<E> = [E] extends [never] ? {} : { fail: E };

export type Parser<A, E = never> = KyootT<A, ParserBase & FailRow<E>>;

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

export const letter = satisfy((c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z"), "letter");

export const string = (s: string) =>
  Kyoot.gen(function* () {
    for (const c of s) yield* char(c);
    return s;
  });

export const regex = (re: RegExp, expected: string): Parser<string> =>
  Kyoot.gen(function* () {
    const pos = yield* getPos;
    const m = re.exec(yield* restSlice);
    if (m === null || m.index !== 0) return yield* expectedHere(expected);
    yield* seek(pos + m[0].length);
    return m[0];
  });

export const endOfInput: Parser<void> = Kyoot.gen(function* () {
  const c = yield* peek;
  if (c !== undefined) return yield* expectedHere("end of input");
}) as Parser<void>;

const or2 = (p: AnyKyoot, q: AnyKyoot): AnyKyoot =>
  Kyoot.gen(function* () {
    const mark = yield* getPos;
    return yield* p.pipe(
      catchParse((e1) =>
        Kyoot.gen(function* () {
          yield* seek(mark);
          return yield* q.pipe(catchParse((e2) => parseFail(e2.pos >= e1.pos ? e2 : e1)));
        }),
      ),
    );
  });

export function or<A, S1 extends ParserRow, B, S2 extends ParserRow>(
  p: KyootT<A, S1>,
  q: KyootT<B, S2>,
): KyootT<A | B, Simplify<Merge<S1, S2>>> {
  return or2(p, q);
}

export const oneOf = <A, S extends ParserRow>(ps: ReadonlyArray<KyootT<A, S>>): KyootT<A, S> => {
  let acc: AnyKyoot = parseFail(new ParseError(0, "one of", undefined));
  for (let i = ps.length - 1; i >= 0; i--) acc = or2(ps[i]!, acc);
  return acc as KyootT<A, S>;
};

export const many = <A, S extends ParserRow>(
  p: KyootT<A, S>,
  opts?: { atLeast?: number },
): KyootT<A[], S> =>
  Kyoot.gen(function* () {
    const out: A[] = [];
    const atLeast = opts?.atLeast ?? 0;
    for (let i = 0; i < atLeast; i++) out.push(yield* p);
    while (true) {
      const r = yield* or2(
        p.map((a): { readonly more: true; readonly a: A } => ({ more: true, a })),
        succeed({ more: false } as const),
      );
      if (!r.more) return out;
      out.push(r.a);
    }
  }) as KyootT<A[], S>;

export const optional = <A, S extends ParserRow>(p: KyootT<A, S>): KyootT<A | undefined, S> =>
  or2(p, succeed(undefined)) as KyootT<A | undefined, S>;

export const sepBy = <A, S extends ParserRow, S2 extends ParserRow>(
  p: KyootT<A, S>,
  sep: KyootT<unknown, S2>,
): KyootT<A[], Simplify<Merge<S, S2>>> =>
  Kyoot.gen(function* () {
    const first = yield* optional(p);
    if (first === undefined) return [] as A[];
    const restItems = yield* many(
      Kyoot.gen(function* () {
        yield* sep;
        return yield* p;
      }) as AnyKyoot,
    );
    return [first, ...restItems];
  }) as KyootT<A[], Simplify<Merge<S, S2>>>;
