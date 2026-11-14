import { effect, gen, answering, type Intercept } from "../core.ts";
import type { Kyoot } from "../model.ts";
import type { MergeAll, Op, Row } from "../types.ts";

type VarRow<Id extends string, V> = {
  [K in `var/${Id}`]: Op<VarOp<V>, any>;
};

export type VarOp<V> =
  | { readonly kind: "get" }
  | { readonly kind: "set"; readonly value: V }
  | { readonly kind: "update"; readonly f: (value: V) => V };

export interface Tag<Id extends string, V> {
  get(): Kyoot<V, VarRow<Id, V>>;
  set(value: V): Kyoot<void, VarRow<Id, V>>;
  update(f: (value: V) => V): Kyoot<void, VarRow<Id, V>>;
  readonly intercept: Intercept<`var/${Id}`, VarOp<V>, any>;
  run(
    initial: V,
  ): <A, S extends Row & Partial<VarRow<Id, V>>>(
    k: Kyoot<A, S>,
  ) => Kyoot<readonly [A, V], MergeAll<Omit<S, `var/${Id}`>>>;
}

export const tag =
  <V>() =>
  <const Id extends string>(id: Id): Tag<Id, V> => {
    const v = effect<VarOp<V>, any>()(`var/${id}` as const);
    const get = v({ kind: "get" });
    return {
      get: () => get,
      set: (value) => v({ kind: "set", value }),
      update: (f) => v({ kind: "update", f }),
      intercept: v.intercept,
      run: (initial) => (k) =>
        gen(function* () {
          let value = initial;
          const a = yield* k.pipe(
            answering(v.key, (op: VarOp<V>) => {
              switch (op.kind) {
                case "get":
                  return value;
                case "set":
                  value = op.value;
                  return undefined;
                case "update":
                  value = op.f(value);
                  return undefined;
              }
            }),
          );
          return [a, value] as const;
        }) as never,
    };
  };
