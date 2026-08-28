import { makeHandler, makeIntercept, makeOp, type Intercept } from "../core.ts";
import type { Kyoot } from "../model.ts";
import type { MergeAll, Row } from "../types.ts";

type EnvRow<Id extends string, E> = {
  [K in `env/${Id}`]: E;
};

export interface Tag<Id extends string, E> extends Iterable<Kyoot<unknown, EnvRow<Id, E>>, E> {
  readonly key: `env/${Id}`;
  get(): Kyoot<E, EnvRow<Id, E>>;
  // Wrap the service: `next()` asks the handler outside for it.
  readonly intercept: Intercept<`env/${Id}`, void, E, never, E>;
  provide(
    impl: E,
  ): <A, S extends Row & Partial<EnvRow<Id, E>>>(
    k: Kyoot<A, S>,
  ) => Kyoot<A, MergeAll<Omit<S, `env/${Id}`>>>;
}

export const tag =
  <E>() =>
  <const Id extends string>(id: Id): Tag<Id, E> => {
    const effectKey = `env/${id}` as const;
    const get = () => makeOp(effectKey, undefined) as Kyoot<E, EnvRow<Id, E>>;
    return {
      key: effectKey,
      get,
      [Symbol.iterator]: () => get()[Symbol.iterator](),
      intercept: makeIntercept<`env/${Id}`, void, E, never, E>(effectKey),
      provide: (impl) => (k) => makeHandler(effectKey, k, { onOp: (_, resume) => resume(impl) }),
    };
  };
