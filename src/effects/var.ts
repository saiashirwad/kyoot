import { invoke, makeOp, succeed } from "../core.ts";
import { makeHandler } from "../handler.ts";
import type { AnyKyoot, Kyoot } from "../model.ts";
import type { Row, Simplify } from "../types.ts";

type VarRow<Id extends string, V> = {
  [K in `var/${Id}`]: V;
};

type VarOp<V> =
  | { readonly kind: "get" }
  | { readonly kind: "set"; readonly value: V }
  | { readonly kind: "update"; readonly f: (value: V) => V };

const keys = new Map<string, symbol>();

const keyFor = (id: string): symbol => {
  const existing = keys.get(id);
  if (existing !== undefined) return existing;
  const key = Symbol(`kyoot.var/${id}`);
  keys.set(id, key);
  return key;
};

export function Tag<V>() {
  return function <const Id extends string>(id: Id) {
    const effectKey = keyFor(id);

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
        return <A, S extends Row & VarRow<Id, V>>(
          k: Kyoot<A, S>,
        ): Kyoot<[A, V], Simplify<Omit<S, `var/${Id}`>>> =>
          makeHandler({
            effectKey,
            self: k as AnyKyoot,
            make: () => {
              let value = initial;
              return {
                onOp: (op: VarOp<V>, resume) => {
                  switch (op.kind) {
                    case "get":
                      return resume(value);
                    case "set":
                      value = op.value;
                      return resume(undefined);
                    case "update":
                      value = invoke(() => op.f(value));
                      return resume(undefined);
                  }
                },
                onSuccess: (a) => succeed([a, value]),
              };
            },
          }) as Kyoot<[A, V], Simplify<Omit<S, `var/${Id}`>>>;
      }
    };
  };
}
