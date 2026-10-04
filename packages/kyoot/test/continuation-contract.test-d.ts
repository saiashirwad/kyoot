import {
  effect,
  Kyoot,
  makeHandler,
  type EffectRow,
  type Requirement,
  type RowsOf,
} from "../src/index.ts";

const Plain = effect<void, number>()("n");
const NumberContinuation = effect<void, number, EffectRow<"s", void, number>>()("n");
const StringContinuation = effect<void, number, EffectRow<"s", void, string>>()("n");
const Same = effect<void, number, EffectRow<"s", void, number>>()("n");
const NumberSource = effect<void, number>()("s");
const StringSource = effect<void, string>()("s");

const needsNumber = NumberContinuation.handle({
  onOp: (_, resume) => resume.with(NumberSource(undefined)),
});
const needsString = StringContinuation.handle({
  onOp: (_, resume) => resume.with(StringSource(undefined).map((text) => text.length)),
});

// @ts-expect-error a handler cannot introduce an undeclared continuation requirement
const erased: Kyoot<number, {}> = Plain(undefined).pipe(needsNumber);
// @ts-expect-error continuation answers are part of the declaration's contract
NumberContinuation(undefined).pipe(needsString);
// @ts-expect-error a declaration without continuation permissions has a different contract
NumberContinuation(undefined).pipe(Plain.handle({ onOp: (_, resume) => resume(1) }));
// @ts-expect-error direct handlers require matching continuation permissions
NumberContinuation.handler(Plain(undefined), { onOp: (_, resume) => resume(1) });
// @ts-expect-error direct handlers require matching continuation answers
StringContinuation.handler(NumberContinuation(undefined), { onOp: (_, resume) => resume(1) });
// @ts-expect-error interceptors cannot give a plain operation continuation permissions
Plain(undefined).pipe(NumberContinuation.intercept((_, next) => next(undefined)));
// @ts-expect-error interceptors cannot replace the continuation answer contract
NumberContinuation(undefined).pipe(StringContinuation.intercept((_, next) => next(undefined)));
// @ts-expect-error interceptors cannot discard the declaration's continuation contract
NumberContinuation(undefined).pipe(Plain.intercept(() => Kyoot.succeed(1)));

type NumberRow = RowsOf<ReturnType<typeof NumberContinuation>>;
type StringRow = RowsOf<ReturnType<typeof StringContinuation>>;
type PlainRow = RowsOf<ReturnType<typeof Plain>>;
declare const plainEntry: PlainRow["n"];
// @ts-expect-error fixed requirement entries retain invariant continuation permissions
const numberEntry: NumberRow["n"] = plainEntry;
// @ts-expect-error adding independent keys cannot change an existing continuation contract
const acquiredContinuation: Kyoot<number, NumberRow> = Plain(undefined);
// @ts-expect-error a continuation contract cannot be erased through a row annotation
const erasedContinuation: Kyoot<number, PlainRow & EffectRow<"s", void, number>> =
  NumberContinuation(undefined);
// @ts-expect-error intersection cannot combine incompatible continuation contracts
const intersection: Kyoot<number, PlainRow & NumberRow> = Plain(undefined);
// @ts-expect-error union cannot widen an existing continuation contract
const union: Kyoot<number, { n: PlainRow["n"] | NumberRow["n"] }> = Plain(undefined);

const mixed = Kyoot.gen(function* () {
  yield* Plain(undefined);
  return yield* NumberContinuation(undefined);
});
// @ts-expect-error a declaration handler cannot consume incompatible continuation contracts
mixed.pipe(needsNumber);
// @ts-expect-error a declaration interceptor cannot consume incompatible continuation contracts
mixed.pipe(NumberContinuation.intercept(() => Kyoot.succeed(1)));

const Nested = effect<void, number, NumberRow>()("nested");
Nested.handle({
  // @ts-expect-error resume.with must preserve nested continuation contracts
  onOp: (_, resume) => resume.with(Plain(undefined)),
});
NumberContinuation.handle({
  // @ts-expect-error resume.with cannot use a different answer for an allowed key
  onOp: (_, resume) => resume.with(StringSource(undefined).map((text) => text.length)),
});
makeHandler("n", NumberContinuation(undefined), {
  // @ts-expect-error raw-key handlers permit only effect-free resume.with programs
  onOp: (_, resume) => resume.with(NumberSource(undefined)),
});

const takesNumber = (program: Kyoot<number, NumberRow>) => program;
// @ts-expect-error function arguments cannot add continuation permissions to an existing key
takesNumber(Plain(undefined));
// @ts-expect-error pipe cannot add continuation permissions to an existing key
Plain(undefined).pipe(takesNumber);
// @ts-expect-error return annotations cannot add continuation permissions to an existing key
const returnsNumber = (): Kyoot<number, NumberRow> => Plain(undefined);

const same: Kyoot<number, NumberRow> = Same(undefined);
const independent: Kyoot<number, PlainRow & EffectRow<"extra", void, string>> = Plain(undefined);
const pure: Kyoot<number, NumberRow> = Kyoot.succeed(1);
const result: number = Kyoot.runSync(
  NumberContinuation(undefined).pipe(
    Same.intercept((_, next) => next(undefined)),
    needsNumber,
    NumberSource.handle({ onOp: (_, resume) => resume(7) }),
  ),
);
const direct = Same.handler(NumberContinuation(undefined), {
  onOp: (_, resume) => resume.with(NumberSource(undefined)),
});
Nested.handle({ onOp: (_, resume) => resume.with(NumberContinuation(undefined)) });
makeHandler("n", mixed, { onOp: (_, resume) => resume.with(Kyoot.succeed(1)) });
makeHandler("n", NumberContinuation(undefined), { onOp: (_, resume) => resume(1) });

type Expect<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type _numberSource = Expect<Equal<NumberRow["s"], EffectRow<"s", void, number>["s"]>>;
type _stringSource = Expect<Equal<StringRow["s"], EffectRow<"s", void, string>["s"]>>;
type _explicitContinuation = Expect<
  Equal<NumberRow["n"], EffectRow<"n", void, number, EffectRow<"s", void, number>>["n"]>
>;
const CustomValue = effect<void, number, EffectRow<"s", void, number>, string>()("custom");
type _customValue = Expect<
  Equal<
    RowsOf<ReturnType<typeof CustomValue>>["custom"],
    Requirement<void, number, string, EffectRow<"s", void, number>>
  >
>;
type _explicitValue = Expect<
  Equal<
    RowsOf<ReturnType<typeof CustomValue>>["custom"],
    EffectRow<"custom", void, number, EffectRow<"s", void, number>, string>["custom"]
  >
>;

const OptionalS = effect<void, number>()("optional/s");
const OptionalPlain = effect<void, number>()("optional/n");
const OptionalContinuation = effect<void, number, Partial<EffectRow<"optional/s", void, number>>>()(
  "optional/n",
);
OptionalPlain(undefined).pipe(
  // @ts-expect-error an optional continuation key cannot disappear through a plain declaration
  OptionalContinuation.handle({ onOp: (_, resume) => resume.with(OptionalS(undefined)) }),
);
// @ts-expect-error direct handlers retain optional continuation keys
OptionalContinuation.handler(OptionalPlain(undefined), {
  onOp: (_, resume) => resume.with(OptionalS(undefined)),
});
// @ts-expect-error interceptors retain optional continuation keys
OptionalPlain(undefined).pipe(OptionalContinuation.intercept((_, next) => next(undefined)));
const optionalCompatible = OptionalContinuation(undefined).pipe(
  OptionalContinuation.handle({ onOp: (_, resume) => resume.with(OptionalS(undefined)) }),
  OptionalS.handle({ onOp: (_, resume) => resume(1) }),
);
Kyoot.runSync(optionalCompatible);

type OptionalSourceRow = Partial<EffectRow<"optional/s", void, number>>;
type OptionalOperationRow = EffectRow<"optional/n", void, number, OptionalSourceRow>;
// @ts-expect-error optional outer row keys cannot be erased by a direct annotation
const erasedOptionalRow: Kyoot<number, OptionalOperationRow> = OptionalContinuation(undefined);
function eraseOptional<C extends OptionalSourceRow>(
  program: Kyoot<number, EffectRow<"optional/n", void, number, C> & OptionalSourceRow>,
): Kyoot<number, EffectRow<"optional/n", void, number, C>> {
  return program;
}
// @ts-expect-error performed requirements cannot enter a generic erasing optional annotation
eraseOptional(OptionalContinuation(undefined));
const UnionContinuation = effect<
  void,
  number,
  OptionalSourceRow | EffectRow<"optional/s", void, number>
>()("union/n");
// @ts-expect-error a union continuation retains its optional outer key
const erasedUnionRow: Kyoot<
  number,
  EffectRow<"union/n", void, number, OptionalSourceRow | EffectRow<"optional/s", void, number>>
> = UnionContinuation(undefined);
type MappedSourceRow = { readonly [K in keyof OptionalSourceRow]?: OptionalSourceRow[K] };
const MappedContinuation = effect<void, number, MappedSourceRow>()("mapped/n");
// @ts-expect-error mapped optional continuation keys remain required in the variance witness
const erasedMappedRow: Kyoot<
  number,
  EffectRow<"mapped/n", void, number, MappedSourceRow>
> = MappedContinuation(undefined);
const OptionalString = effect<void, string>()("optional/s");
OptionalContinuation(undefined).pipe(
  OptionalContinuation.handle({ onOp: (_, resume) => resume.with(OptionalS(undefined)) }),
  // @ts-expect-error an optional number continuation cannot acquire a string answer
  OptionalString.handle({ onOp: (_, resume) => resume("wrong") }),
);

type AlternativeSourceRow =
  | Partial<EffectRow<"optional/s", void, number>>
  | Partial<EffectRow<"optional/s", void, string>>;
const AlternativeContinuation = effect<void, number, AlternativeSourceRow>()("alternative/n");
// @ts-expect-error an annotation cannot select one answer branch of a union continuation
const narrowedAlternative: Kyoot<
  number,
  EffectRow<"alternative/n", void, number, AlternativeSourceRow> &
    EffectRow<"optional/s", void, string>
> = AlternativeContinuation(undefined);

type RequiredAlternativeRow =
  | EffectRow<"optional/s", void, number>
  | EffectRow<"optional/s", void, string>;
const RequiredAlternative = effect<void, number, RequiredAlternativeRow>()(
  "required-alternative/n",
);
// @ts-expect-error required union continuation entries cannot narrow to one answer branch
const narrowedRequiredAlternative: Kyoot<
  number,
  EffectRow<"required-alternative/n", void, number, RequiredAlternativeRow> &
    EffectRow<"optional/s", void, string>
> = RequiredAlternative(undefined);
