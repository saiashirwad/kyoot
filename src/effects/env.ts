import { opKyoot, pureKyoot, type AnyKyoot, type Kyoot } from "../core.ts";
import { makeHandler } from "../handler.ts";
import type { Row, Simplify } from "../types.ts";

// Env — dependencies. Each service gets a distinct key via a
// template-literal key from its name ('env/inventory'), and `provide` is a
// handler answering that one key. No Layer graph, no memoization.

export function service<T>() {
  return <N extends string>(name: N): Kyoot<T, { [K in `env/${N}`]: T }> =>
    opKyoot(`env/${name}`, undefined) as Kyoot<T, { [K in `env/${N}`]: T }>;
}

export function provide<N extends string, T>(name: N, impl: T) {
  const key = `env/${name}`;
  // The impl must be assignable to the service type named in the row
  // (checked via the intersection witness, evaluated once S is inferred).
  return <A, S extends Row & { [K in `env/${N}`]: unknown }>(
    k: Kyoot<A, S> & (T extends S[`env/${N}`] ? unknown : never),
  ): Kyoot<A, Simplify<Omit<S, `env/${N}`>>> =>
    makeHandler({
      key,
      self: k as AnyKyoot,
      onOp: (_payload, resume) => resume(impl),
      onPure: (a) => pureKyoot(a),
    }) as Kyoot<A, Simplify<Omit<S, `env/${N}`>>>;
}
