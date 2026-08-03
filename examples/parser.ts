import { Choice, effect, Kyoot, succeed } from "../src/index.ts";
import type { Row } from "../src/index.ts";

type Expr = number | { readonly op: "+" | "-"; readonly left: Expr; readonly right: Expr };

type Token = number | "+" | "-";

const Cursor = effect<"cursor", void>("cursor");

const nextChar = Cursor.op<string | undefined>(undefined);

export const cursor = (source: string) => {
  const handle = Cursor.handle<number>({
    state: 0,
    onOp: (_p, resume, pos) => resume(source[pos], pos + 1),
    onSuccess: (a) => succeed(a),
  });
  return <A, S extends Row & { cursor?: void } = {}>(k: Kyoot<A, S>) => handle<A, S, A>(k);
};

export const lex = Kyoot.gen(function* () {
  const tokens: Token[] = [];
  let digits = "";
  const flush = () => {
    if (digits !== "") {
      tokens.push(Number(digits));
      digits = "";
    }
  };
  while (true) {
    const c = yield* nextChar;
    if (c === undefined) {
      flush();
      return tokens;
    }
    if (c === " ") continue;
    if (c === "+" || c === "-") {
      flush();
      tokens.push(c);
      continue;
    }
    if (c >= "0" && c <= "9") {
      digits += c;
      continue;
    }
    throw new Error(`unexpected character '${c}'`);
  }
});

export const tree = (tokens: ReadonlyArray<Token>): Kyoot<Expr, { choice: true }> =>
  Kyoot.gen(function* () {
    if (tokens.length === 1) return tokens[0] as number;
    const splits: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === "+" || tokens[i] === "-") splits.push(i);
    }
    const i = yield* Choice.get(splits);
    const left = yield* tree(tokens.slice(0, i));
    const right = yield* tree(tokens.slice(i + 1));
    return { op: tokens[i] as "+" | "-", left, right };
  });

export const parseAll = (source: string) =>
  Kyoot.gen(function* () {
    const tokens = yield* lex;
    return yield* tree(tokens);
  }).pipe(cursor(source), Choice.run());

export const evaluate = (e: Expr): number =>
  typeof e === "number"
    ? e
    : e.op === "+"
      ? evaluate(e.left) + evaluate(e.right)
      : evaluate(e.left) - evaluate(e.right);

export const show = (e: Expr): string =>
  typeof e === "number" ? String(e) : `(${show(e.left)} ${e.op} ${show(e.right)})`;

if (process.argv[1]?.endsWith("parser.ts")) {
  for (const source of ["10-3-2", "1+2+3+4"]) {
    const parses = Kyoot.runSync(parseAll(source));
    console.log(`${source} — ${parses.length} parses:`);
    for (const p of parses) console.log(`  ${show(p)} = ${evaluate(p)}`);
    console.log();
  }
}
