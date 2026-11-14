import { answerAll, effect, gen, type Intercept } from "../core.ts";
import type { Kyoot } from "../model.ts";
import type { MergeAll, Op, Row } from "../types.ts";

export type GetRow<Id extends string, V> = { [K in `var/${Id}/get`]: Op<void, V> };
export type SetRow<Id extends string, V> = { [K in `var/${Id}/set`]: Op<V, void> };
export type UpdateRow<Id extends string, V> = {
  [K in `var/${Id}/update`]: Op<(value: V) => V, void>;
};
export type VarRow<Id extends string, V> = GetRow<Id, V> & SetRow<Id, V> & UpdateRow<Id, V>;

export interface Tag<Id extends string, V> {
  get(): Kyoot<V, GetRow<Id, V>>;
  set(value: V): Kyoot<void, SetRow<Id, V>>;
  update(f: (value: V) => V): Kyoot<void, UpdateRow<Id, V>>;
  readonly intercept: {
    readonly get: Intercept<`var/${Id}/get`, void, V>;
    readonly set: Intercept<`var/${Id}/set`, V, void>;
    readonly update: Intercept<`var/${Id}/update`, (value: V) => V, void>;
  };
  run(
    initial: V,
  ): <A, S extends Row & Partial<VarRow<Id, V>>>(
    k: Kyoot<A, S>,
  ) => Kyoot<readonly [A, V], MergeAll<MergeAll<Omit<S, keyof VarRow<Id, V>>>>>;
}

export const tag =
  <V>() =>
  <const Id extends string>(id: Id): Tag<Id, V> => {
    const get = effect<void, V>()(`var/${id}/get` as const);
    const set = effect<V, void>()(`var/${id}/set` as const);
    const update = effect<(value: V) => V, void>()(`var/${id}/update` as const);
    const getOp = get(undefined);
    return {
      get: () => getOp,
      set,
      update,
      intercept: { get: get.intercept, set: set.intercept, update: update.intercept },
      run: (initial) => (k) =>
        gen(function* () {
          let value = initial;
          const a = yield* answerAll(
            { get, set, update },
            {
              get: () => value,
              set: (v) => {
                value = v;
              },
              update: (f) => {
                value = f(value);
              },
            },
          )(k);
          return [a, value] as const;
        }),
    };
  };
