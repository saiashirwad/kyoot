import { KyootImpl } from "./core.ts";
import type { AnyKyoot, Kyoot, OnOp, Resume } from "./model.ts";
import type { Row } from "./types.ts";

export type Handler<K extends PropertyKey, In, Out> = <A, S extends Row & { [P in K]: In }>(
  k: Kyoot<A, S>,
) => Kyoot<Out, Omit<S, K>>;

export function makeHandler<State = undefined>(spec: {
  readonly effectKey: PropertyKey;
  readonly self: AnyKyoot;
  readonly state?: State;
  readonly onOp: (payload: any, resume: Resume, state: State) => AnyKyoot;
  readonly onSuccess: (a: any, state: State) => AnyKyoot;
  readonly onDefect?: (d: unknown, state: State) => AnyKyoot;
  readonly onInterrupt?: (state: State) => void;
}): AnyKyoot {
  return new KyootImpl({
    _tag: "handler",
    effectKey: spec.effectKey,
    self: spec.self,
    state: spec.state,
    onOp: spec.onOp as OnOp,
    onSuccess: spec.onSuccess as (a: any, state: any) => AnyKyoot,
    onDefect: spec.onDefect as ((d: unknown, state: any) => AnyKyoot) | undefined,
    onInterrupt: spec.onInterrupt as ((state: any) => void) | undefined,
  });
}
