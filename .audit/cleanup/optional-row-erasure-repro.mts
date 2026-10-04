import { effect, Kyoot, type EffectRow } from "../../packages/kyoot/src/index.ts";
const Source = effect<void, number>()("s");
type Continuation = Partial<EffectRow<"s", void, number>>;
const Optional = effect<void, number, Continuation>()("n");
const erased: Kyoot<number, EffectRow<"n", void, number, Continuation>> = Optional(undefined);
const pure = erased.pipe(Optional.handle({ onOp: (_, r) => r.with(Source(undefined)) }));
const value: number = Kyoot.runSync(pure);
console.log(value);
