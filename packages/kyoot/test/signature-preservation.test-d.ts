import {
  Async,
  Clock,
  Emit,
  Env,
  Fail,
  Kyoot,
  Log,
  Resource,
  Retry,
  Var,
  effect,
} from "../src/index.ts";
import type { Kyoot as Program } from "../src/index.ts";

const NumberAnswer = effect<string, number>()("signature/answer");
const StringAnswer = effect<string, string>()("signature/answer");
const wrong = StringAnswer.handle({ onOp: (_, resume) => resume("wrong") });
const compatible = NumberAnswer.handle({ onOp: (_, resume) => resume(1) });
const legacy: Program<void> = Kyoot.succeed(undefined);
const mintedAfterLegacy = legacy.flatMap(() => NumberAnswer("key"));
mintedAfterLegacy.pipe(compatible, Kyoot.runSync);
// @ts-expect-error a compatibility annotation on the left cannot erase a newly minted operation
mintedAfterLegacy.pipe(wrong);

const annotatedCallback = (): Program<void> => Kyoot.succeed(undefined);
const keptAcrossCallback = NumberAnswer("key").flatMap(annotatedCallback);
// @ts-expect-error a compatibility callback cannot erase the input operation signature
keptAcrossCallback.pipe(wrong);

// @ts-expect-error collectors preserve other operation signatures
NumberAnswer("key").pipe(Log.collect, wrong);
// @ts-expect-error clock handling preserves other operation signatures
NumberAnswer("key").pipe(Clock.virtual, wrong);
// @ts-expect-error scopes preserve other operation signatures
NumberAnswer("key").pipe(Resource.run, wrong);
// @ts-expect-error retry preserves the original operation signature
NumberAnswer("key").pipe(Retry.run({ retries: 1 }), wrong);
// @ts-expect-error emission handlers preserve other operation signatures
NumberAnswer("key").pipe(Emit.collect, wrong);
// @ts-expect-error fork inheritance preserves the child operation signature
Async.fork(NumberAnswer("key")).pipe(wrong);
// @ts-expect-error all preserves every branch's operation signature
Async.all([NumberAnswer("key")]).pipe(wrong);
// @ts-expect-error race preserves both branches' operation signatures
Async.race(NumberAnswer("key"), Kyoot.succeed(0)).pipe(wrong);
// @ts-expect-error timeout preserves the wrapped operation signature
Async.timeout(1, NumberAnswer("key")).pipe(wrong);
const withOpener = Resource.acquireEffect(
  () => NumberAnswer("key"),
  () => Kyoot.succeed(undefined),
).pipe(Resource.run);
// @ts-expect-error resource acquisition preserves the opener operation signature
withOpener.pipe(wrong);
const withRelease = Resource.acquire(
  () => 1,
  () => NumberAnswer("key"),
).pipe(Resource.run);
// @ts-expect-error resource release preserves the finalizer operation signature
withRelease.pipe(wrong);

const Service = Env.tag<number>()("signature/service");
// @ts-expect-error providing a service does not erase other operation signatures
NumberAnswer("key").pipe(Service.provide(1), wrong);
const State = Var.tag<number>()("signature/state");
// @ts-expect-error variable handling preserves other operation signatures
NumberAnswer("key").pipe(State.run(0), wrong);

const both = Kyoot.gen(function* () {
  yield* Clock.sleep(0);
  yield* Log.info("test");
  return yield* NumberAnswer("key");
});
both.pipe(Clock.virtual, Log.collect, compatible, Kyoot.runSync);

// The public row remains a payload map and declared failures remain checked.
declare const union: Program<number, { fail: string } | { log: Log.Entry }>;
const providedUnion = union.pipe(Service.provide(1));
// @ts-expect-error service provision does not remove either unhandled branch
Kyoot.runSync(providedUnion);
providedUnion.pipe(Fail.run, Log.discard, Kyoot.runSync);
