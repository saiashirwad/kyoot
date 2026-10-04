import {
  Async,
  Emit,
  Fail,
  Env,
  Resource,
  Sync,
  Var,
  effect,
  Kyoot,
  makeHandler,
  type EffectRow,
  type Kyoot as K,
} from "../src/index.ts";
const N = effect<void, number>()("n");
const S = effect<void, string>()("n");
// @ts-expect-error existing row entries cannot be strengthened by intersection
const intersection: K<number, EffectRow<"n", void, number> & EffectRow<"n", void, string>> =
  N(undefined);
const pure: K<number, EffectRow<"n", void, number>> = Kyoot.succeed(1);
const extra: K<number, EffectRow<"n", void, number> & EffectRow<"s", void, string>> = N(undefined);
const Clock = effect<void, string>()("clock");
// @ts-expect-error runner contracts cannot be laundered through intersection
const served: K<string, EffectRow<"clock", void, string> & { clock: number }> = Clock(undefined);
declare const union: "n" | "s";
declare const wide: string;
declare const template: `tag/${string}`;
// @ts-expect-error one runtime dispatch key cannot represent multiple static keys
makeHandler(union, extra, { onOp: () => Kyoot.succeed(1) });
// @ts-expect-error effect keys must identify a single operation
effect<void, number>()(union);
// @ts-expect-error wide dispatch keys are not checked
effect<void, number>()(wide);
// @ts-expect-error open template dispatch keys are not checked
effect<void, number>()(template);
// @ts-expect-error continuation rows cannot redefine the performed key
effect<void, number, EffectRow<"n", void, string>>()("n");
// @ts-expect-error broad continuation rows overlap the performed key
effect<void, number, Record<string, unknown>>()("n");
const counter = Var.tag<number>()("counter");
const fakeVar = effect<Var.VarOp<number>, string, {}, number>()("var/counter");
// @ts-expect-error fixed handlers cannot replace dependent Var answers
fakeVar.handler(counter.get(), { onOp: (_, r) => r("bad") });
// @ts-expect-error Var handlers cannot consume a fixed answer operation
fakeVar({ kind: "get" }).pipe(counter.run(0));
// @ts-expect-error checked handlers cannot infer an answer for a dependent operation
makeHandler("var/counter", counter.get(), { onOp: (_, r) => r("bad") });
// @ts-expect-error Sync replacement requires explicit unsafe opt-in
Sync.handle({ onOp: (_, r) => r("bad") });
// @ts-expect-error Sync interception requires explicit unsafe opt-in
Sync.intercept(() => Kyoot.succeed("bad"));
// @ts-expect-error Async interception requires explicit unsafe opt-in
Async.intercept(() => Kyoot.succeed("bad"));
// @ts-expect-error Resource interception requires explicit unsafe opt-in
Resource.intercept()(() => Kyoot.succeed("bad"));
// @ts-expect-error Var interception requires explicit unsafe opt-in
counter.intercept(() => Kyoot.succeed("bad"));
// @ts-expect-error dynamic Env IDs cannot remove multiple requirements
Env.tag<number>()(union);
// @ts-expect-error dynamic Var IDs cannot remove multiple requirements
Var.tag<number>()(wide);
const fakeEmit = effect<void, number>()("emit");
// @ts-expect-error emit collection must not resume a number operation with undefined
fakeEmit(undefined).pipe(Emit.collect);
const fakeFail = effect<void, number>()("fail");
// @ts-expect-error the failure runner requires an aborting operation contract
fakeFail(undefined).pipe(Fail.run);
declare const empty: never;
// @ts-expect-error no dispatch identity exists for never
effect<void, number>()(empty);
// @ts-expect-error a never Env ID is not a known identity
Env.tag<number>()(empty);
// @ts-expect-error a never Var ID is not a known identity
Var.tag<number>()(empty);
// @ts-expect-error a continuation union may not contain the operation key in any branch
effect<void, number, EffectRow<"n", void, string> | EffectRow<"s", void, string>>()("n");
declare const numericTemplate: `${number}`;
declare const branded: string & { readonly brand: unique symbol };
declare const symbolKey: symbol;
// @ts-expect-error numeric template keys remain infinite
effect<void, number>()(numericTemplate);
// @ts-expect-error branding an open string does not make its value known
effect<void, number>()(branded);
// @ts-expect-error checked key handling cannot remove an open set of keys
makeHandler(wide, N(undefined), { onOp: () => Kyoot.succeed(1) });
// @ts-expect-error broad symbols do not identify one dispatch key
makeHandler(symbolKey, N(undefined), { onOp: () => Kyoot.succeed(1) });
// @ts-expect-error explicit generic arguments do not bypass singleton checking
effect<void, number>()<"n" | "s">("n");
// @ts-expect-error explicit handler generics do not bypass singleton checking
makeHandler<"n" | "s", number, EffectRow<"n", void, number>>("n", N(undefined), {
  onOp: (_, resume) => resume(1),
});
// @ts-expect-error unknown row entries cannot replace a fixed requirement
const unknownRow: K<number, { n: unknown }> = N(undefined);
// @ts-expect-error existing entries cannot be widened to incompatible contract unions
const unionRow: K<
  number,
  { n: EffectRow<"n", void, number>["n"] | EffectRow<"n", void, string>["n"] }
> = N(undefined);
// @ts-expect-error adding a broad index row cannot erase a concrete requirement
const indexRow: K<number, Record<string, unknown>> = N(undefined);
// @ts-expect-error raw rows carry no checked answer
makeHandler("n", raw, { onOp: () => Kyoot.succeed(1) });
declare const raw: K<number, { n: void }>;
const syncProgram = Sync.defer(() => 1);
const asyncProgram = Async.fromPromise(async () => 1);
const resourceProgram = Resource.acquire(
  () => 1,
  () => {},
);
// @ts-expect-error dependent Sync answers are unavailable to fixed handlers
makeHandler("sync", syncProgram, { onOp: (_, r) => r("bad") });
// @ts-expect-error dependent Async answers are unavailable to fixed handlers
makeHandler("async", asyncProgram, { onOp: (_, r) => r("bad") });
// @ts-expect-error dependent Resource answers are unavailable to fixed handlers
makeHandler("resource", resourceProgram, { onOp: (_, r) => r("bad") });
const takesExtra = (k: K<number, EffectRow<"n", void, number> & EffectRow<"s", void, string>>) => k;
takesExtra(N(undefined));
N(undefined).pipe(takesExtra);
const returnsExtra = (): K<number, EffectRow<"n", void, number> & EffectRow<"s", void, string>> =>
  N(undefined);
const independent = effect<void, number, EffectRow<"s", void, string>>()("n");
const NeedsS = effect<void, string>()("s");
independent(undefined).pipe(
  independent.handle({ onOp: (_, r) => r.with(NeedsS(undefined).map(() => 1)) }),
);
const failProgram = Fail.fail("bad");
makeHandler("fail", failProgram, {
  // @ts-expect-error an aborting operation has no resume value
  onOp: (_, r) => r(undefined),
});
// @ts-expect-error fixed Sync lookalikes cannot be consumed by its dependent runner
effect<() => unknown, number>()("sync")(() => 1).pipe(Sync.run);
const fixedResource = effect<Resource.ResourceOp, number>()("resource")({
  acquire: () => 1,
  release: () => {},
});
// @ts-expect-error fixed Resource lookalikes cannot be consumed by its dependent runner
fixedResource.pipe(Resource.run);
type Expect<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type RawAnswer = import("../src/index.ts").Answer<{ raw: void }, "raw">;
type _rawAnswer = Expect<Equal<RawAnswer, never>>;
const badError = Fail.fail({ _tag: "Bad" as const });
const badCatch = Fail.catchTag("Bad", (e: { _tag: "Bad"; detail: string }) =>
  Kyoot.succeed(e.detail),
);
// @ts-expect-error the catch callback cannot assume fields absent from the matching error
badError.pipe(badCatch);
