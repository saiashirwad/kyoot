import { makeOp, succeed } from "../core.ts";
import { makeHandler } from "../handler.ts";
import type { AnyKyoot, Kyoot } from "../model.ts";
import type { Row, Simplify } from "../types.ts";

export function service<T>() {
  return <N extends string>(name: N): Kyoot<T, { [K in `env/${N}`]: T }> =>
    makeOp(`env/${name}`, undefined) as Kyoot<T, { [K in `env/${N}`]: T }>;
}

export function provide<N extends string, T>(name: N, impl: T) {
  const effectKey = `env/${name}`;
  return <A, S extends Row & { [K in `env/${N}`]: unknown }>(
    k: Kyoot<A, S> & (T extends S[`env/${N}`] ? unknown : never),
  ): Kyoot<A, Simplify<Omit<S, `env/${N}`>>> =>
    makeHandler({
      effectKey,
      self: k as AnyKyoot,
      onOp: (_payload, resume) => resume(impl),
      onSuccess: (a) => succeed(a),
    }) as Kyoot<A, Simplify<Omit<S, `env/${N}`>>>;
}
