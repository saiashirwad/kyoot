import { KyootImpl, makeOp, succeed } from "../core.ts";
import type { Kyoot } from "../model.ts";
import type { Row, Simplify } from "../types.ts";

type EnvRow<Id extends string, E> = {
  [K in `env/${Id}`]: E;
};

export function Tag<E>() {
  return function <const Id extends string>(id: Id) {
    const effectKey = `env/${id}`;
    return class {
      static service(): Kyoot<E, EnvRow<Id, E>> {
        return makeOp(effectKey, undefined) as any;
      }

      static [Symbol.iterator](): Iterator<Kyoot<unknown, EnvRow<Id, E>>, E, unknown> {
        return this.service()[Symbol.iterator]();
      }

      static provide(impl: E) {
        return <A, S extends Row & Partial<EnvRow<Id, E>> = {}>(
          k: Kyoot<A, S>,
        ): Kyoot<A, Simplify<Omit<S, `env/${Id}`>>> =>
          new KyootImpl<A, Simplify<Omit<S, `env/${Id}`>>>({
            _tag: "handler",
            effectKey,
            self: k,
            onOp: (_, resume) => resume(impl),
            onSuccess: (a) => succeed(a),
          });
      }
    };
  };
}
