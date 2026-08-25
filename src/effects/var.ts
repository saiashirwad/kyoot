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

export function Tag<V>() {
  return function <const Id extends string>(id: Id) {
    const effectKey = `var/${id}`;

    return class {
      static get(): Kyoot<V, VarRow<Id, V>> {
        return makeOp(effectKey, { kind: "get" }) as Kyoot<V, VarRow<Id, V>>;
      }

      static set(value: V): Kyoot<void, VarRow<Id, V>> {
        return makeOp(effectKey, { kind: "set", value }) as Kyoot<void, VarRow<Id, V>>;
      }

      static update(f: (value: V) => V): Kyoot<void, VarRow<Id, V>> {
        return makeOp(effectKey, { kind: "update", f }) as Kyoot<void, VarRow<Id, V>>;
      }

      static run(initial: V) {
        return <A, S extends Row & Partial<VarRow<Id, V>> = {}>(
          k: Kyoot<A, S>,
        ): Kyoot<[A, V], Simplify<Omit<S, `var/${Id}`>>> =>
          new KyootImpl({
            _tag: "handler",
            effectKey,
            self: k as AnyKyoot,
            state: initial as V,
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
          });
      }
    };
  };
}
