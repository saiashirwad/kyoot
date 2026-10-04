import { effect, Kyoot, type EffectRow } from "../../packages/kyoot/src/index.ts";
type Numbers = EffectRow<"s", void, number>;
type Strings = EffectRow<"s", void, string>;
type C = Partial<Numbers> | Partial<Strings>;
const Source = effect<void, number>()("s");
const Wrong = effect<void, string>()("s");
const N = effect<void, number, C>()("n");
const narrowed: Kyoot<number, EffectRow<"n", void, number, C> & Strings> = N(undefined);
const pure = narrowed.pipe(
  N.handle({ onOp: (_, r) => r.with(Source(undefined)) }),
  Wrong.handle({ onOp: (_, r) => r("wrong answer") }),
);
const result: number = Kyoot.runSync(pure);
console.log("typed number:", result, "runtime typeof:", typeof result);
