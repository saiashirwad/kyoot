import { KyootImpl, makeOp } from "./core.ts";
import type { AnyKyoot, Kyoot, Resume } from "./model.ts";
import type { Row, Simplify } from "./types.ts";

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

export function effect<Key extends string, About = unknown, Payload = About>(key: Key) {
  type R = { [K in Key]: About };
  return {
    key,
    op<A>(payload: Payload): Kyoot<A, R> {
      return makeOp(key, payload) as Kyoot<A, R>;
    },
    handle<State = undefined>(spec: {
      readonly state?: State;
      readonly onOp: (payload: Payload, resume: Resume, state: State) => AnyKyoot;
      readonly onSuccess: (a: any, state: State) => AnyKyoot;
      readonly onDefect?: (d: unknown, state: State) => AnyKyoot;
      readonly onInterrupt?: (state: State) => void;
    }) {
      return <A, S extends Row & Partial<R>, Out>(
        k: Kyoot<A, S>,
      ): Kyoot<Out, Simplify<Omit<S, Key>>> =>
        makeHandler<State>({
          effectKey: key,
          self: k as AnyKyoot,
          state: spec.state,
          onOp: spec.onOp,
          onSuccess: spec.onSuccess,
          onDefect: spec.onDefect,
          onInterrupt: spec.onInterrupt,
        }) as Kyoot<Out, Simplify<Omit<S, Key>>>;
    },
  };
}
