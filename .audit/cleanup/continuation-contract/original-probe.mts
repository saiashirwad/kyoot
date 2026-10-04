import assert from "node:assert/strict";
import { effect, Kyoot, type EffectRow } from "../../../packages/kyoot/src/index.ts";
const Plain = effect<void, number>()("n");
const NeedsS = effect<void, number, EffectRow<"s", void, number>>()("n");
const S = effect<void, number>()("s");
const handled: Kyoot<number, {}> = Plain(undefined).pipe(
  NeedsS.handle({ onOp: (_, resume) => resume.with(S(undefined)) }),
);
assert.throws(() => Kyoot.runSync(handled), /unhandled effect 's'/);
const NumberContinuation = effect<void, number, EffectRow<"s", void, number>>()("n");
const StringContinuation = effect<void, number, EffectRow<"s", void, string>>()("n");
const Text = effect<void, string>()("s");
const typedNumber: number = Kyoot.runSync(
  NumberContinuation(undefined).pipe(
    StringContinuation.handle({
      onOp: (_, resume) => resume.with(Text(undefined).map((text) => text.length)),
    }),
    S.handle({ onOp: (_, resume) => resume(7) }),
  ),
);
assert.equal(typedNumber, undefined);
console.log(
  "Pure continuation: unhandled s. Typed number with incompatible continuation contracts: actual",
  typedNumber,
);
