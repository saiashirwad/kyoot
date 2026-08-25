import { bench, run, group, summary } from "mitata";
import { Effect, Context, Ref } from "effect";
import * as K from "../src/index.ts";
import { Env, Var, Emit, Fail, Sync, Async, Kyoot } from "../src/index.ts";

const N = 100;
const which = process.argv[2] ?? "all";
const on = (g: string) => which === "all" || which === g;

// ---------- 1. runSync of a trivial program ----------
if (on("tiny")) group("runSync(succeed(1))", () => {
  bench("effect", () => Effect.runSync(Effect.succeed(1)));
  bench("kyoot", () => Kyoot.runSync(Kyoot.succeed(1)));
});

// ---------- 2. map chain ----------
if (on("map")) group(`map chain x${N} (build+run)`, () => {
  bench("effect", () => {
    let e = Effect.succeed(0);
    for (let i = 0; i < N; i++) e = Effect.map(e, (x) => x + 1);
    return Effect.runSync(e);
  });
  bench("kyoot", () => {
    let k: K.Kyoot<number> = Kyoot.succeed(0);
    for (let i = 0; i < N; i++) k = k.map((x) => x + 1);
    return Kyoot.runSync(k);
  });
});

// ---------- 3. gen yields of pure ----------
if (on("gen")) group(`gen: ${N} yields of succeed`, () => {
  const e = Effect.gen(function* () {
    let s = 0;
    for (let i = 0; i < N; i++) s += yield* Effect.succeed(i);
    return s;
  });
  const k = Kyoot.gen(function* () {
    let s = 0;
    for (let i = 0; i < N; i++) s += yield* Kyoot.succeed(i);
    return s;
  });
  bench("effect", () => Effect.runSync(e));
  bench("kyoot", () => Kyoot.runSync(k));
});

// ---------- 4. service lookup ----------
if (on("env")) group(`env: ${N} service gets`, () => {
  class Svc extends Context.Service<Svc, { n: number }>()("Svc") {}
  const e = Effect.gen(function* () {
    let s = 0;
    for (let i = 0; i < N; i++) s += (yield* Svc).n;
    return s;
  }).pipe(Effect.provideService(Svc, { n: 1 }));
  const KSvc = Env.tag<{ n: number }>()("svc");
  const k = Kyoot.gen(function* () {
    let s = 0;
    for (let i = 0; i < N; i++) s += (yield* KSvc.get()).n;
    return s;
  }).pipe(KSvc.provide({ n: 1 }));
  bench("effect", () => Effect.runSync(e));
  bench("kyoot", () => Kyoot.runSync(k));
});

// ---------- 5. state ----------
if (on("state")) group(`state: ${N} updates + get`, () => {
  const e = Effect.gen(function* () {
    const r = yield* Ref.make(0);
    for (let i = 0; i < N; i++) yield* Ref.update(r, (x) => x + 1);
    return yield* Ref.get(r);
  });
  const Count = Var.tag<number>()("count");
  const k = Kyoot.gen(function* () {
    for (let i = 0; i < N; i++) yield* Count.update((x) => x + 1);
    return yield* Count.get();
  }).pipe(Count.run(0));
  bench("effect", () => Effect.runSync(e));
  bench("kyoot", () => Kyoot.runSync(k));
});

// ---------- 6. sync thunks ----------
if (on("sync")) group(`sync: ${N} deferred thunks`, () => {
  const e = Effect.gen(function* () {
    let s = 0;
    for (let i = 0; i < N; i++) s += yield* Effect.sync(() => i);
    return s;
  });
  const k = Kyoot.gen(function* () {
    let s = 0;
    for (let i = 0; i < N; i++) s += yield* Sync.defer(() => i);
    return s;
  }).pipe(Sync.run);
  bench("effect", () => Effect.runSync(e));
  bench("kyoot", () => Kyoot.runSync(k));
});

// ---------- 7. fail + catch ----------
if (on("fail")) group(`fail: 10 yields then fail, caught (x1)`, () => {
  const e = Effect.gen(function* () {
    let s = 0;
    for (let i = 0; i < 10; i++) s += yield* Effect.succeed(i);
    if (s > 0) return yield* Effect.fail("boom" as const);
    return s;
  }).pipe(Effect.result);
  const k = Kyoot.gen(function* () {
    let s = 0;
    for (let i = 0; i < 10; i++) s += yield* Kyoot.succeed(i);
    if (s > 0) return yield* Fail.fail("boom" as const);
    return s;
  }).pipe(Fail.run);
  bench("effect", () => Effect.runSync(e));
  bench("kyoot", () => Kyoot.runSync(k));
});

// ---------- 8. stacked handlers ----------
if (on("stack")) group(`stack: env+state+emit+fail handlers, ${N} mixed ops`, () => {
  class Svc extends Context.Service<Svc, { n: number }>()("Svc2") {}
  const e = Effect.gen(function* () {
    const r = yield* Ref.make(0);
    const log = yield* Ref.make<number[]>([]);
    for (let i = 0; i < N; i++) {
      const s = yield* Svc;
      yield* Ref.update(r, (x) => x + s.n);
      yield* Ref.update(log, (xs) => [...xs, i]);
    }
    return yield* Ref.get(r);
  }).pipe(Effect.provideService(Svc, { n: 1 }), Effect.result);
  const KSvc = Env.tag<{ n: number }>()("svc2");
  const Count = Var.tag<number>()("count2");
  const k = Kyoot.gen(function* () {
    for (let i = 0; i < N; i++) {
      const s = yield* KSvc.get();
      yield* Count.update((x) => x + s.n);
      yield* Emit.value(i);
    }
    return yield* Count.get();
  }).pipe(KSvc.provide({ n: 1 }), Count.run(0), Emit.run, Fail.run);
  bench("effect", () => Effect.runSync(e));
  bench("kyoot", () => Kyoot.runSync(k));
});

// ---------- 9. async ----------
if (on("async")) group(`async: ${N} resolved promises`, () => {
  const e = Effect.gen(function* () {
    let s = 0;
    for (let i = 0; i < N; i++) s += yield* Effect.promise(() => Promise.resolve(i));
    return s;
  });
  const k = Kyoot.gen(function* () {
    let s = 0;
    for (let i = 0; i < N; i++) s += yield* Async.fromPromise(() => Promise.resolve(i));
    return s;
  });
  bench("effect", async () => await Effect.runPromise(e));
  bench("kyoot", async () => await Kyoot.runPromise(k));
});

// ---------- 10. checkout example ----------
if (on("checkout")) group("checkout example (3 items)", () => {
  class OutOfStock { readonly _tag = "OutOfStock"; sku: string; constructor(sku: string) { this.sku = sku; } }
  class Declined { readonly _tag = "Declined"; reason: string; constructor(reason: string) { this.reason = reason; } }
  const order = { id: "o1", items: [{ sku: "a", qty: 1, priceCents: 100 }, { sku: "b", qty: 2, priceCents: 250 }, { sku: "c", qty: 1, priceCents: 999 }] };
  const card = { number: "4242" };

  // effect
  class Inv extends Context.Service<Inv, { reserve(sku: string, qty: number): Effect.Effect<boolean> }>()("Inv") {}
  class Pay extends Context.Service<Pay, { charge(t: number, c: typeof card): Effect.Effect<string, Declined> }>()("Pay") {}
  const eCheckout = Effect.gen(function* () {
    const inv = yield* Inv;
    const pay = yield* Pay;
    const total = yield* Ref.make(0);
    const events = yield* Ref.make<Array<{ type: "reserved"; sku: string }>>([]);
    for (const item of order.items) {
      const ok = yield* inv.reserve(item.sku, item.qty);
      if (!ok) yield* Effect.fail(new OutOfStock(item.sku));
      yield* Ref.update(events, (xs) => [...xs, { type: "reserved" as const, sku: item.sku }]);
      yield* Ref.update(total, (t) => t + item.priceCents * item.qty);
    }
    const t = yield* Ref.get(total);
    const chargeId = yield* pay.charge(t, card);
    return { orderId: order.id, chargeId, totalCents: t };
  }).pipe(
    Effect.provideService(Inv, { reserve: (sku, qty) => Effect.sync(() => qty > 0) }),
    Effect.provideService(Pay, { charge: (t) => Effect.sync(() => `ch_${t}`) }),
    Effect.result,
  );

  // kyoot
  const KInv = Env.tag<{ reserve(sku: string, qty: number): K.Kyoot<boolean, { sync: true }> }>()("inv");
  const KPay = Env.tag<{ charge(t: number, c: typeof card): K.Kyoot<string, { sync: true; fail: Declined }> }>()("pay");
  const Total = Var.tag<number>()("total");
  const kCheckout = Kyoot.gen(function* () {
    const inv = yield* KInv.get();
    const pay = yield* KPay.get();
    for (const item of order.items) {
      const ok = yield* inv.reserve(item.sku, item.qty);
      if (!ok) yield* Fail.fail(new OutOfStock(item.sku));
      yield* Emit.value({ type: "reserved" as const, sku: item.sku });
      yield* Total.update((t) => t + item.priceCents * item.qty);
    }
    const t = yield* Total.get();
    const chargeId = yield* pay.charge(t, card);
    return { orderId: order.id, chargeId, totalCents: t };
  }).pipe(
    Total.run(0),
    KInv.provide({ reserve: (sku, qty) => Sync.defer(() => qty > 0) }),
    KPay.provide({ charge: (t) => Sync.defer(() => `ch_${t}`) }),
    Emit.run,
    Fail.run,
    Sync.run,
  );
  bench("effect", () => Effect.runSync(eCheckout));
  bench("kyoot", () => Kyoot.runSync(kCheckout));
});

await run({ format: "markdown" });
