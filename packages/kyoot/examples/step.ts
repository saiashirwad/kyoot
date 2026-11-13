import { effect, Kyoot } from "../src/index.ts";

export type Event =
  | { readonly type: "add"; readonly sku: string }
  | { readonly type: "pay" }
  | { readonly type: "paid" }
  | { readonly type: "cancel" };

const Recv = effect<void, Event>()("recv");
const recv = Recv(undefined);

const shopping = Kyoot.gen(function* () {
  const cart: string[] = [];
  while (true) {
    const event = yield* recv;
    if (event.type === "add") cart.push(event.sku);
    if (event.type === "pay") return cart;
  }
});

const paying = (cart: readonly string[]) =>
  Kyoot.gen(function* () {
    while ((yield* recv).type !== "paid");
    return `paid for ${cart.join(", ")}`;
  });

const cancellable = Recv.handle({
  onOp: (_, resume) =>
    recv.flatMap((event) => (event.type === "cancel" ? Kyoot.succeed("cancelled") : resume(event))),
});

export const checkout = (log: string[]) =>
  Kyoot.gen(function* () {
    try {
      return yield* paying(yield* shopping);
    } finally {
      log.push("closed");
    }
  }).pipe(cancellable);

export const drive = (events: Iterable<Event>, log: string[] = []) => {
  let current = Kyoot.step(checkout(log));
  for (const event of events) {
    if (current.done) break;
    current = current.resume(event);
  }
  if (current.done) return current.value;
  current.cancel();
  return "abandoned";
};

if (import.meta.main) {
  console.log(drive([{ type: "add", sku: "book" }, { type: "pay" }, { type: "paid" }]));
}
