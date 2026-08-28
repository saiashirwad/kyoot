import { effect, isKyoot, type Intercept } from "../core.ts";
import type { Kyoot } from "../model.ts";
import type { MergeAll, Row } from "../types.ts";

export type EnvRow<Id extends string, E> = {
  [K in `env/${Id}`]: E;
};

export interface Tag<Id extends string, E> extends Iterable<Kyoot<unknown, EnvRow<Id, E>>, E> {
  readonly key: `env/${Id}`;
  get(): Kyoot<E, EnvRow<Id, E>>;
  // Wrap the service: `next()` asks the handler outside for it.
  readonly intercept: Intercept<`env/${Id}`, void, E, {}, E>;
  // Provide a value, or a program that makes one: it runs once, where the
  // handler sits, so the handlers outside answer what it needs.
  provide(
    impl: E,
  ): <A, S extends Row & Partial<EnvRow<Id, E>>>(
    k: Kyoot<A, S>,
  ) => Kyoot<A, MergeAll<Omit<S, `env/${Id}`>>>;
  provide<S2 extends Row>(
    make: Kyoot<E, S2>,
  ): <A, S extends Row & Partial<EnvRow<Id, E>>>(
    k: Kyoot<A, S>,
  ) => Kyoot<A, MergeAll<Omit<S, `env/${Id}`> | S2>>;
}

// The row records the service type, not the (empty) payload.
export const tag =
  <E>() =>
  <const Id extends string>(id: Id): Tag<Id, E> => {
    const env = effect<void, E, {}, E>()(`env/${id}` as const);
    // Nodes are immutable, so every `get` is the same one.
    const get = env(undefined);
    return {
      key: env.key,
      get: () => get,
      [Symbol.iterator]: () => get[Symbol.iterator](),
      intercept: env.intercept,
      provide: (impl: E | Kyoot<E, Row>) => {
        const withValue = (e: E) => env.handle({ onOp: (_, resume) => resume(e) });
        if (!isKyoot(impl)) return withValue(impl as E);
        return (k: Kyoot<unknown, Row>) => impl.flatMap((e) => withValue(e)(k as never));
      },
    } as Tag<Id, E>;
  };
