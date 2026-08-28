import { effect, type Intercept } from "../core.ts";
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

// The row records the service type, not the (empty) payload.
export const tag =
  <E>() =>
  <const Id extends string>(id: Id): Tag<Id, E> => {
    const env = effect<void, E, never, E>()(`env/${id}` as const);
    // Nodes are immutable, so every `get` is the same one.
    const get = env(undefined);
    return {
      key: env.key,
      get: () => get,
      [Symbol.iterator]: () => get[Symbol.iterator](),
      intercept: env.intercept,
      provide: (impl) => env.handle({ onOp: (_, resume) => resume(impl) }),
    };
  };
