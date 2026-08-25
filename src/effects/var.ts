import { KyootImpl, makeOp, succeed } from "../core.ts";
import type { AnyKyoot, Kyoot } from "../model.ts";
import type { Row, Simplify } from "../types.ts";

type VarRow<Id extends string, V> = {
  [K in `var/${Id}`]: V;
};

type VarOp<V> =
  | { readonly kind: "get" }
  | { readonly kind: "set"; readonly value: V }
  | { readonly kind: "update"; readonly f: (value: V) => V };

export interface Tag<Id extends string, V> {
  get(): Kyoot<V, VarRow<Id, V>>;
  set(value: V): Kyoot<void, VarRow<Id, V>>;
  update(f: (value: V) => V): Kyoot<void, VarRow<Id, V>>;
  run(
    initial: V,
  ): <A, S extends Row & Partial<VarRow<Id, V>> = {}>(
    k: Kyoot<A, S>,
  ) => Kyoot<[A, V], Simplify<Omit<S, `var/${Id}`>>>;
}

export const tag =
  <V>() =>
  <const Id extends string>(id: Id): Tag<Id, V> => {
    const effectKey = `var/${id}`;
    const op = (op: VarOp<V>) => makeOp(effectKey, op) as Kyoot<any, VarRow<Id, V>>;
    const getNode = op({ kind: "get" });
    return {
      get: () => getNode,
      set: (value) => op({ kind: "set", value }),
      update: (f) => op({ kind: "update", f }),
      run: (initial) => (k) =>
        new KyootImpl({
          _tag: "handler",
          effectKey,
          self: k as AnyKyoot,
          state: initial,
          onOp: (op: VarOp<V>, resume, value: V) => {
            switch (op.kind) {
              case "get":
                return resume(value);
              case "set":
                return resume(undefined, op.value);
              case "update":
                return resume(undefined, op.f(value));
            }
          },
          onSuccess: (a, value) => succeed([a, value]),
        }),
    };
  };
