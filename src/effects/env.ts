import { KyootImpl, makeOp } from "../core.ts";
import type { Kyoot } from "../model.ts";
import type { Row, Simplify } from "../types.ts";

type EnvRow<Id extends string, E> = {
  [K in `env/${Id}`]: E;
};

export interface Tag<Id extends string, E> extends Iterable<Kyoot<unknown, EnvRow<Id, E>>, E> {
  get(): Kyoot<E, EnvRow<Id, E>>;
  provide(
    impl: E,
  ): <A, S extends Row & Partial<EnvRow<Id, E>> = {}>(
    k: Kyoot<A, S>,
  ) => Kyoot<A, Simplify<Omit<S, `env/${Id}`>>>;
}

export const tag =
  <E>() =>
  <const Id extends string>(id: Id): Tag<Id, E> => {
    const effectKey = `env/${id}`;
    const node = makeOp(effectKey, undefined) as Kyoot<E, EnvRow<Id, E>>;
    const get = () => node;
    return {
      get,
      [Symbol.iterator]: () => get()[Symbol.iterator](),
      provide: (impl) => (k) =>
        new KyootImpl({ _tag: "handler", effectKey, self: k, onOp: (_, resume) => resume(impl) }),
    };
  };
