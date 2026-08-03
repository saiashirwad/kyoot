import { KyootImpl } from "./core.ts";
import type { AnyKyoot, Resume } from "./model.ts";

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
    onOp: spec.onOp,
    onSuccess: spec.onSuccess,
    onDefect: spec.onDefect,
    onInterrupt: spec.onInterrupt,
  });
}
