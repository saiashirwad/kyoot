import { KyootImpl } from "./core.ts";
import type { AnyKyoot, Kyoot, RuntimeNode } from "./model.ts";
import type { Row } from "./types.ts";

export type Handler<K extends string, In, Out> = <A, S extends Row & { [P in K]: In }>(
  k: Kyoot<A, S>,
) => Kyoot<Out, Omit<S, K>>;

export const makeHandler = (
  spec: Omit<Extract<RuntimeNode, { _tag: "handler" }>, "_tag">,
): AnyKyoot => new KyootImpl({ _tag: "handler", ...spec });
