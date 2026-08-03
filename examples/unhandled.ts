import { Emit, Fail, Kyoot } from "../src/index.ts";

class NotFound {
  readonly _tag = "NotFound";
}

const program = Kyoot.gen(function* () {
  yield* Emit.value("looking");
  yield* Fail.fail(new NotFound());
  return "found";
});

try {
  // @ts-expect-error Unhandled<"emit" | "fail">
  Kyoot.runSync(program);
} catch (e) {
  console.log((e as Error).message);
}

try {
  // @ts-expect-error Unhandled<"emit">
  Kyoot.runSync(program.pipe(Fail.run()));
} catch (e) {
  console.log((e as Error).message);
}

const r = Kyoot.runSync(program.pipe(Fail.run(), Emit.discard()));
console.log(r);
