import { Emit, Fail, Kyoot } from "kyoot";
import { checkout, Inventory, OutOfStock, Payments } from "./checkout.ts";

const order = { id: "o-1", items: [{ sku: "book", qty: 2, priceCents: 1200 }] };

const placeOrder = Kyoot.gen(function* () {
  const [receipt] = yield* checkout(order, "4242");
  return `charged ${receipt.chargeId}`;
});

const placeOrderOrSkip = Kyoot.gen(function* () {
  const [receipt] = yield* checkout(order, "4242").pipe(
    Fail.catchTag("OutOfStock", (e: OutOfStock) =>
      Kyoot.succeed([
        { orderId: order.id, chargeId: `skipped:${e.sku}`, totalCents: 0 },
        0,
      ] as const),
    ),
  );
  return `charged ${receipt.chargeId}`;
});

const stock = Inventory.handle({
  initial: new Map([["book", 1]]),
  onOp: ({ sku, qty }, resume, s) => {
    const have = s.get(sku) ?? 0;
    return have >= qty ? resume(true, new Map(s).set(sku, have - qty)) : resume(false);
  },
});

const pay = Payments.handle({
  onOp: ({ totalCents }, resume) => resume(`ch_${totalCents}`),
});

console.log(placeOrder.pipe(stock, pay, Emit.discard, Fail.run, Kyoot.runSync));

console.log(placeOrderOrSkip.pipe(stock, pay, Emit.discard, Kyoot.runSync));
