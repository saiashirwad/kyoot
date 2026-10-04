import { effect, Kyoot, type EffectRow } from "../../packages/kyoot/src/index.ts";
const S = effect<void, number>()("s");
const N = effect<void, number>()("n");
const Opt = effect<void, number, Partial<EffectRow<"s", void, number>>>()("n");
const pure = N(undefined).pipe(Opt.handle({ onOp: (_, r) => r.with(S(undefined)) }));
const result: number = Kyoot.runSync(pure);
console.log(result);
