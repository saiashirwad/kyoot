// Type-level tests. Checked by `tsc --noEmit`, never executed.
import { Abort, Async, Emit, Env, Kyoot, Sync, Var } from "../src/index.ts";
import type { Kyoot as KyoT, Merge, Result } from "../src/index.ts";

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// --- Merge forces a canonical form -----------------------------------------

type _Merge = Expect<
  Equal<
    Merge<{ abort: TypeError }, { abort: RangeError; var: number }>,
    { abort: TypeError | RangeError; var: number }
  >
>;

// --- gen: two abort sources land in one slot as a union ---------------------
// (payloads must be structurally distinct — TS cannot tell TypeError and
// RangeError apart, they have the same shape)

class ErrA {
  readonly a = "a";
}
class ErrB {
  readonly b = 1;
}

const twoAborts = Kyoot.gen(function* () {
  yield* Abort.fail(new ErrA());
  yield* Abort.fail(new ErrB());
  return 1;
});
type _TwoAborts = Expect<Equal<typeof twoAborts, KyoT<number, { abort: ErrA | ErrB }>>>;

// --- gen: rows accumulate across effects ------------------------------------

const multi = Kyoot.gen(function* () {
  yield* Var.set(1);
  yield* Emit.value("e");
  yield* Sync.defer(() => 1);
  yield* Abort.fail(new Error("x"));
  return "done";
});
type _Multi = Expect<
  Equal<typeof multi, KyoT<string, { var: number; emit: string; sync: true; abort: Error }>>
>;

// --- handler elimination removes exactly its key ----------------------------

declare const prog: KyoT<number, { abort: Error; var: number; emit: string }>;

const afterAbort = prog.pipe(Abort.run());
type _AfterAbort = Expect<
  Equal<typeof afterAbort, KyoT<Result<Error, number>, { var: number; emit: string }>>
>;

const afterVar = prog.pipe(Var.run(0));
type _AfterVar = Expect<
  Equal<typeof afterVar, KyoT<[number, number], { abort: Error; emit: string }>>
>;

const afterEmit = prog.pipe(Emit.run());
type _AfterEmit = Expect<
  Equal<typeof afterEmit, KyoT<[number, string[]], { abort: Error; var: number }>>
>;

// --- runSync only accepts an empty row --------------------------------------

declare const pending: KyoT<number, { abort: Error }>;
declare const handled: KyoT<number>;

// @ts-expect-error — non-empty row does not compile
Kyoot.runSync(pending);

Kyoot.runSync(handled);

// --- runPromise accepts at most `async` -------------------------------------

declare const asyncProg: KyoT<number, { async: true }>;

Kyoot.runPromise(asyncProg);
Kyoot.runPromise(handled);

// @ts-expect-error — a pending non-async effect does not compile
Kyoot.runPromise(pending);

// --- map auto-flatten merges rows -------------------------------------------

const flattened = handled.map((n) => Abort.fail(new Error()).map(() => n + 1));
type _Flattened = Expect<Equal<typeof flattened, KyoT<number, { abort: Error }>>>;

const plainMap = handled.map((n) => n + 1);
type _PlainMap = Expect<Equal<typeof plainMap, KyoT<number>>>;

// --- 10+ deep composition still infers --------------------------------------

const d0 = Kyoot.gen(function* () {
  return 0;
});
const d1 = Kyoot.gen(function* () {
  const a = yield* d0;
  yield* Var.set(a);
  return a + 1;
});
const d2 = Kyoot.gen(function* () {
  const a = yield* d1;
  yield* Emit.value(a);
  return a + 1;
});
const d3 = Kyoot.gen(function* () {
  const a = yield* d2;
  yield* Sync.defer(() => a);
  return a + 1;
});
const d4 = Kyoot.gen(function* () {
  const a = yield* d3;
  yield* Abort.fail("e4");
  return a + 1;
});
const d5 = Kyoot.gen(function* () {
  const a = yield* d4;
  yield* Async.sleep(0);
  return a + 1;
});
const d6 = Kyoot.gen(function* () {
  const a = yield* d5;
  yield* Var.update<number>((v) => v + 1);
  return a + 1;
});
const d7 = Kyoot.gen(function* () {
  const a = yield* d6;
  yield* Emit.value("e7");
  return a + 1;
});
const d8 = Kyoot.gen(function* () {
  const a = yield* d7;
  yield* Abort.fail(new TypeError());
  return a + 1;
});
const d9 = Kyoot.gen(function* () {
  const a = yield* d8;
  yield* Sync.defer(() => a);
  return a + 1;
});
const d10 = Kyoot.gen(function* () {
  const a = yield* d9;
  yield* Async.suspend<number>((resume) => resume(a));
  return a + 1;
});
type _Deep = Expect<
  Equal<
    typeof d10,
    KyoT<
      number,
      { var: number; emit: string | number; sync: true; abort: string | TypeError; async: true }
    >
  >
>;

// --- the full pipeline at the edge ------------------------------------------

const atTheEdge = d10.pipe(Var.run(0), Emit.discard(), Sync.run(), Abort.run());
// @ts-expect-error — async is still pending, runSync must not compile
Kyoot.runSync(atTheEdge);

Kyoot.runPromise(atTheEdge);

// --- Env template-literal keys ----------------------------------------------

interface Inventory {
  reserve(sku: string, qty: number): KyoT<boolean, { sync: true }>;
}
const InventoryTag = Env.service<Inventory>()("inventory");
const usesInventory = Kyoot.gen(function* () {
  const inv = yield* InventoryTag;
  return yield* inv.reserve("sku", 1);
});
type _UsesInventory = Expect<
  Equal<typeof usesInventory, KyoT<boolean, { "env/inventory": Inventory; sync: true }>>
>;

const provided = usesInventory.pipe(
  Env.provide("inventory", { reserve: () => Sync.defer(() => true) }),
);
type _Provided = Expect<Equal<typeof provided, KyoT<boolean, { sync: true }>>>;

// --- fork/race require handled-down-to-async inputs --------------------------

declare const needsAbort: KyoT<number, { async: true; abort: Error }>;
// @ts-expect-error — a fiber is an independent loop; outer handlers can't see its ops
Async.fork(needsAbort);

export {};
