import { Kyoot, Result } from "../src/index.ts";
import {
  ParseError,
  char,
  digit,
  endOfInput,
  error,
  many,
  oneOf,
  parse,
  string,
} from "../parser/index.ts";

class OutOfRange {
  readonly _tag = "OutOfRange";
  readonly n: number;
  constructor(n: number) {
    this.n = n;
  }
}

const byte = Kyoot.gen(function* () {
  const digits = yield* many(digit, { atLeast: 1 });
  const n = Number(digits.join(""));
  if (n > 255) return yield* error(new OutOfRange(n));
  return n;
});

const ip = Kyoot.gen(function* () {
  const a = yield* byte;
  yield* char(".");
  const b = yield* byte;
  yield* char(".");
  const c = yield* byte;
  yield* char(".");
  const d = yield* byte;
  yield* endOfInput;
  return [a, b, c, d] as const;
});

const greeting = oneOf([string("hello"), string("help"), string("goodbye")]);

if (process.argv[1]?.endsWith("parseff.ts")) {
  for (const source of ["192.168.1.1", "10.0.300.7", "192.168.1", "not-an-ip"]) {
    const r = parse(source, ip);
    if (Result.isOk(r)) {
      console.log(`${source}  →  parsed: ${r.value.join(".")}`);
    } else if (r.cause._tag === "Fail" && r.cause.error instanceof ParseError) {
      console.log(`${source}  →  ${r.cause.error.format(source)}`);
    } else if (r.cause._tag === "Fail" && r.cause.error instanceof OutOfRange) {
      console.log(`${source}  →  out of range: ${r.cause.error.n} (0-255)`);
    }
  }

  console.log();
  for (const source of ["help", "helter skelter"]) {
    const r = parse(source, greeting);
    console.log(
      Result.isOk(r)
        ? `${source}  →  greeting: ${r.value}`
        : `${source}  →  ${(r.cause as { error: ParseError }).error.format(source)}`,
    );
  }
}
