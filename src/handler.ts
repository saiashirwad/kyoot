import { KyootImpl } from "./core.ts";
import type { AnyKyoot, HandlerClauses, Kyoot } from "./model.ts";
import type { Row } from "./types.ts";

export type Handler<K extends PropertyKey, In, Out> = <A, S extends Row & { [P in K]: In }>(
  k: Kyoot<A, S>,
) => Kyoot<Out, Omit<S, K>>;

// The one way to build a handler. `make` runs once per execution, so state
// is just variables the clauses close over — a stateless handler ignores
// this and a stateful one declares its state as locals.
export const makeHandler = (spec: {
  readonly effectKey: PropertyKey;
  readonly self: AnyKyoot;
  readonly make: () => HandlerClauses;
}): AnyKyoot => new KyootImpl({ _tag: "handler", ...spec });
