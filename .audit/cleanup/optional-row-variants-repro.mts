import { effect, Kyoot, type EffectRow } from "../../packages/kyoot/src/index.ts";
type SourceRow = EffectRow<"s", void, number>;
type OptionalRow = Partial<SourceRow>;
type UnionRow = OptionalRow | SourceRow;
type MappedRow = { readonly [K in keyof SourceRow]?: SourceRow[K] };
const S = effect<void, number>()("s");
const BadS = effect<void, string>()("s");
const Opt = effect<void, number, OptionalRow>()("n");
const Union = effect<void, number, UnionRow>()("union");
const Mapped = effect<void, number, MappedRow>()("mapped");
function erase<C extends OptionalRow>(
  p: Kyoot<number, EffectRow<"n", void, number, C> & OptionalRow>,
): Kyoot<number, EffectRow<"n", void, number, C>> {
  return p;
}
const direct: Kyoot<number, EffectRow<"n", void, number, OptionalRow>> = Opt(undefined);
const generic = erase<OptionalRow>(Opt(undefined));
const union: Kyoot<number, EffectRow<"union", void, number, UnionRow>> = Union(undefined);
const mapped: Kyoot<number, EffectRow<"mapped", void, number, MappedRow>> = Mapped(undefined);
const cases = [
  ["direct", direct.pipe(Opt.handle({ onOp: (_, r) => r.with(S(undefined)) }))],
  ["generic", generic.pipe(Opt.handle({ onOp: (_, r) => r.with(S(undefined)) }))],
  ["union", union.pipe(Union.handle({ onOp: (_, r) => r.with(S(undefined)) }))],
  ["mapped", mapped.pipe(Mapped.handle({ onOp: (_, r) => r.with(S(undefined)) }))],
] satisfies [string, Kyoot<number, {}>][];
for (const [label, p] of cases) {
  try {
    console.log(label, Kyoot.runSync(p));
  } catch (e) {
    console.log(label, e instanceof Error ? e.message : String(e));
  }
}
const result: number = Kyoot.runSync(
  direct.pipe(
    Opt.handle({ onOp: (_, r) => r.with(S(undefined)) }),
    BadS.handle({ onOp: (_, r) => r("wrong answer") }),
  ),
);
console.log("typed number:", result, "runtime typeof:", typeof result);
const positive: number = Kyoot.runSync(
  Opt(undefined).pipe(
    Opt.handle({ onOp: (_, r) => r.with(S(undefined)) }),
    S.handle({ onOp: (_, r) => r(7) }),
  ),
);
if (positive !== 7) throw new Error("matching optional continuation broken");
console.log("positive:", positive);
