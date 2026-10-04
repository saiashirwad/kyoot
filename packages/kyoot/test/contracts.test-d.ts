import {
  effect,
  Kyoot,
  makeHandler,
  type Payload,
  type Requirement,
  type RowsOf,
} from "../src/index.ts";

type Expect<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const NumberAnswer = effect<void, number>()("contract");
const StringAnswer = effect<void, string>()("contract");
const LiteralAnswer = effect<void, 1>()("contract");
const Same = effect<void, number>()("contract");
NumberAnswer(undefined).pipe(Same.handle({ onOp: (_, resume) => resume(2) }));
// @ts-expect-error same dispatch key does not erase the answer contract
NumberAnswer(undefined).pipe(StringAnswer.handle({ onOp: (_, resume) => resume("bad") }));
// @ts-expect-error interceptors require the same answer contract
NumberAnswer(undefined).pipe(StringAnswer.intercept(() => Kyoot.succeed("bad")));
// @ts-expect-error a literal answer cannot accept a handler returning arbitrary numbers
LiteralAnswer(undefined).pipe(NumberAnswer.handle({ onOp: (_, resume) => resume(2) }));
// @ts-expect-error invariance also rejects the opposite widening
NumberAnswer(undefined).pipe(LiteralAnswer.handle({ onOp: (_, resume) => resume(1) }));
const mixed = Kyoot.gen(function* () {
  yield* NumberAnswer(undefined);
  return yield* StringAnswer(undefined);
});
// @ts-expect-error a union of incompatible requirements cannot be partly handled
mixed.pipe(NumberAnswer.handle({ onOp: (_, resume) => resume(2) }));
// @ts-expect-error a union cannot be partly intercepted
mixed.pipe(NumberAnswer.intercept(() => Kyoot.succeed(2)));
makeHandler("contract", NumberAnswer(undefined), {
  // @ts-expect-error raw-key handlers still extract the checked answer
  onOp: (_, resume) => resume("bad"),
});
makeHandler("contract", mixed, {
  // @ts-expect-error no answer satisfies both incompatible operations
  onOp: (_, resume) => resume("bad"),
});
const Maybe = effect<string | undefined, number>()("maybe");
type _maybe = Expect<Equal<Payload<RowsOf<ReturnType<typeof Maybe>>, "maybe">, string | undefined>>;
type _undefined = Expect<Equal<Payload<{ raw: undefined }, "raw">, undefined>>;
type _optional = Expect<Equal<Payload<{ raw?: string }, "raw">, string | undefined>>;
type _checked = Expect<Equal<Payload<{ raw: Requirement<undefined, number> }, "raw">, undefined>>;
makeHandler("maybe", Maybe(undefined), {
  onOp: (payload, resume) => {
    // @ts-expect-error undefined is a real payload, so a string-only assignment is invalid
    const text: string = payload;
    return resume(text.length);
  },
});
const BroadPayload = effect<{ value: number }, void>()("payload");
const NarrowPayload = effect<{ value: 1 }, void>()("payload");
// @ts-expect-error a handler requiring a literal payload cannot consume arbitrary numbers
BroadPayload({ value: 2 }).pipe(NarrowPayload.handle({ onOp: (_, resume) => resume(undefined) }));
// @ts-expect-error payload contracts are invariant in the other direction too
NarrowPayload({ value: 1 }).pipe(BroadPayload.handle({ onOp: (_, resume) => resume(undefined) }));
// @ts-expect-error direct handlers enforce the declaration's answer contract too
StringAnswer.handler(NumberAnswer(undefined), { onOp: (_, resume) => resume("bad") });
// @ts-expect-error interceptors cannot widen a literal answer
LiteralAnswer(undefined).pipe(NumberAnswer.intercept(() => Kyoot.succeed(2)));
makeHandler("contract", LiteralAnswer(undefined), {
  // @ts-expect-error extracted resume retains the literal answer
  onOp: (_, resume) => resume(2),
});
