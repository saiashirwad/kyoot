import { effect, type Intercept } from "../core.ts";
import type {
  Kyoot,
  KnownOperationsOf,
  MergeOperations,
  Operation,
  RemoveOperations,
} from "../model.ts";
import type { MergeAll, Remove, Row } from "../types.ts";

export type EnvRow<Id extends string, E> = {
  [K in `env/${Id}`]: E;
};

type EnvOperation<Id extends string, E> = Operation<`env/${Id}`, void, E>;

export interface Tag<Id extends string, E> extends Iterable<
  Kyoot<unknown, EnvRow<Id, E>, EnvOperation<Id, E>>,
  E
> {
  readonly key: `env/${Id}`;
  get(): Kyoot<E, EnvRow<Id, E>, EnvOperation<Id, E>>;
  readonly intercept: Intercept<`env/${Id}`, void, E, {}, E>;
  provide(
    impl: E,
  ): <A, S extends Row & Partial<EnvRow<Id, E>>, Ops>(
    k: Kyoot<A, S, Ops>,
  ) => Kyoot<A, MergeAll<Remove<S, `env/${Id}`>>, RemoveOperations<Ops, `env/${Id}`>>;
  provideValue(
    impl: E,
  ): <A, S extends Row & Partial<EnvRow<Id, E>>, Ops>(
    k: Kyoot<A, S, Ops>,
  ) => Kyoot<A, MergeAll<Remove<S, `env/${Id}`>>, RemoveOperations<Ops, `env/${Id}`>>;
  provideEffect<S2 extends Row, Ops2>(
    make: Kyoot<E, S2, Ops2>,
  ): <A, S extends Row & Partial<EnvRow<Id, E>>, Ops>(
    k: Kyoot<A, S, Ops>,
  ) => Kyoot<
    A,
    MergeAll<Remove<S, `env/${Id}`> | S2>,
    MergeOperations<RemoveOperations<Ops, `env/${Id}`>, KnownOperationsOf<Kyoot<E, S2, Ops2>>>
  >;
}

export const tag =
  <E>() =>
  <const Id extends string>(id: Id): Tag<Id, E> => {
    const env = effect<void, E, {}, E>()(`env/${id}` as const);
    const get = env(undefined);
    return {
      key: env.key,
      get: () => get,
      [Symbol.iterator]: () => get[Symbol.iterator](),
      intercept: env.intercept,
      provide: (impl: E) => {
        const withValue = (e: E) => env.handle({ onOp: (_, resume) => resume(e) });
        return withValue(impl);
      },
      provideValue: (impl: E) => {
        const withValue = (e: E) => env.handle({ onOp: (_, resume) => resume(e) });
        return withValue(impl);
      },
      provideEffect: (impl: Kyoot<E, Row, unknown>) => {
        const withValue = (e: E) => env.handle({ onOp: (_, resume) => resume(e) });
        return (k: Kyoot<unknown, Row, unknown>) => impl.flatMap((e) => withValue(e)(k as never));
      },
    } as Tag<Id, E>;
  };
