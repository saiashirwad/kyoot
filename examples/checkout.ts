import { Emit, Env, Fail, Kyoot, Sync, Var } from "../src/index.ts";
import type { Kyoot as KyootT } from "../src/index.ts";

export class OutOfStock {
  readonly _tag = "OutOfStock";
  readonly sku: string;
  constructor(sku: string) {
    this.sku = sku;
  }
}

export class PaymentDeclined {
  readonly _tag = "PaymentDeclined";
  readonly reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
}

export interface Order {
  readonly id: string;
  readonly items: ReadonlyArray<{ sku: string; qty: number; priceCents: number }>;
}

export interface Card {
  readonly number: string;
}

export type OrderEvent = { type: "reserved"; sku: string };

export interface Inventory {
  reserve(sku: string, qty: number): KyootT<boolean, { sync: true }>;
}

export interface Payments {
  charge(totalCents: number, card: Card): KyootT<string, { sync: true; fail: PaymentDeclined }>;
}

export class Inventory extends Env.Tag<Inventory>()("inventory") {}
export class Payments extends Env.Tag<Payments>()("payments") {}

class Total extends Var.Tag<number>()("Total") {}

export interface Receipt {
  readonly orderId: string;
  readonly chargeId: string;
  readonly totalCents: number;
}

export const checkout = (order: Order, card: Card) =>
  Kyoot.gen(function* () {
    const inventory = yield* Inventory.service();
    const payments = yield* Payments.service();
    for (const item of order.items) {
      const ok = yield* inventory.reserve(item.sku, item.qty);
      if (!ok) yield* Fail.fail(new OutOfStock(item.sku));
      yield* Emit.value<OrderEvent>({ type: "reserved", sku: item.sku });
      yield* Total.update((t) => t + item.priceCents * item.qty);
    }
    const total = yield* Total.get();
    const chargeId = yield* payments.charge(total, card);
    return { orderId: order.id, chargeId, totalCents: total };
  }).pipe(Total.run(0));

export const productionEdge = (
  order: Order,
  card: Card,
  deps: { inventory: Inventory; payments: Payments; publish: (e: OrderEvent) => void },
) =>
  Kyoot.runPromise(
    checkout(order, card).pipe(
      Inventory.provide(deps.inventory),
      Payments.provide(deps.payments),
      Emit.forEach(deps.publish),
      Fail.run,
      Sync.run,
    ),
  );

export const testEdge = (
  order: Order,
  card: Card,
  deps: { inventory: Inventory; payments: Payments },
) =>
  checkout(order, card).pipe(
    Inventory.provide(deps.inventory),
    Payments.provide(deps.payments),
    Emit.discard,
    Fail.orThrow,
    Sync.run,
    Kyoot.runSync,
  );
