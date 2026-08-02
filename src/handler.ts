import { KyootImpl } from "./core.ts";
import type { AnyKyoot, Kyoot, RuntimeNode, StatefulOnOp } from "./model.ts";
import type { Row } from "./types.ts";

export type Handler<K extends PropertyKey, In, Out> = <A, S extends Row & { [P in K]: In }>(
  k: Kyoot<A, S>,
) => Kyoot<Out, Omit<S, K>>;

export const makeHandler = (
  spec: Omit<Extract<RuntimeNode, { _tag: "handler" }>, "_tag">,
): AnyKyoot => new KyootImpl({ _tag: "handler", ...spec });

export function makeStatefulHandler<State>(spec: {
  readonly effectKey: PropertyKey;
  readonly self: AnyKyoot;
  readonly init: () => State;
  readonly onOp: (state: State, payload: any, resume: (v: any) => AnyKyoot) => AnyKyoot;
  readonly onSuccess: (a: any, state: State) => AnyKyoot;
  readonly onDefect?: (d: unknown, state: State) => AnyKyoot;
}): AnyKyoot {
  return new KyootImpl({
    _tag: "stateful-handler",
    effectKey: spec.effectKey,
    self: spec.self,
    init: spec.init,
    state: undefined,
    initialized: false,
    onOp: spec.onOp as StatefulOnOp,
    onSuccess: spec.onSuccess as (a: any, state: unknown) => AnyKyoot,
    onDefect: spec.onDefect as ((d: unknown, state: unknown) => AnyKyoot) | undefined,
  });
}
