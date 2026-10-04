import {
  makeOp,
  makeIntercept,
  unsafeMakeHandler,
  succeed,
  type DependentRequirement,
  type KeyArgument,
  type Intercept,
} from "../core.ts";
import type { Kyoot } from "../model.ts";
import type { MergeAll, Row } from "../types.ts";

declare const family: unique symbol;

export type VarRow<Id extends string, V> = {
  [K in `var/${Id}`]: DependentRequirement<VarOp<V>, V, typeof family>;
};

export type VarOp<V> =
  | { readonly kind: "get" }
  | { readonly kind: "set"; readonly value: V }
  | { readonly kind: "update"; readonly f: (value: V) => V };

export interface Tag<Id extends string, V> {
  get(): Kyoot<V, VarRow<Id, V>>;
  set(value: V): Kyoot<void, VarRow<Id, V>>;
  update(f: (value: V) => V): Kyoot<void, VarRow<Id, V>>;
  readonly unsafeIntercept: Intercept<
    `var/${Id}`,
    VarOp<V>,
    any,
    {},
    DependentRequirement<VarOp<V>, V, typeof family>
  >;
  run(
    initial: V,
  ): <A, S extends Row & Partial<VarRow<Id, V>>>(
    k: Kyoot<A, S>,
  ) => Kyoot<readonly [A, V], MergeAll<Omit<S, `var/${Id}`>>>;
}

export const tag =
  <V>() =>
  <const Id extends string>(...[id]: KeyArgument<Id>): Tag<Id, V> => {
    const key: `var/${Id}` = `var/${id}`;
    const v = (payload: VarOp<V>) => makeOp(key, payload) as Kyoot<any, VarRow<Id, V>>;
    const get = v({ kind: "get" });
    return {
      get: () => get,
      set: (value) => v({ kind: "set", value }),
      update: (f) => v({ kind: "update", f }),
      unsafeIntercept: makeIntercept<`var/${Id}`, VarOp<V>, any, {}, VarRow<Id, V>[`var/${Id}`]>(
        key,
      ),
      run: (initial) => (k) =>
        unsafeMakeHandler(key, k, {
          initial,
          onOp: (op: VarOp<V>, resume, value) => {
            switch (op.kind) {
              case "get":
                return resume(value);
              case "set":
                return resume(undefined, op.value);
              case "update":
                return resume(undefined, op.f(value));
            }
          },
          onSuccess: (a, value) => succeed([a, value] as const),
        }),
    };
  };
