import { invoke, succeed } from "../core.ts";
import { effect } from "../handler.ts";
import type { Kyoot } from "../model.ts";
import type { Row } from "../types.ts";

type VarRow<Id extends string, V> = {
  [K in `var/${Id}`]: V;
};

type VarOp<V> =
  | { readonly kind: "get" }
  | { readonly kind: "set"; readonly value: V }
  | { readonly kind: "update"; readonly f: (value: V) => V };

export function Tag<V>() {
  return function <const Id extends string>(id: Id) {
    const fx = effect<`var/${Id}`, V, VarOp<V>>(`var/${id}`);

    return class {
      static get(): Kyoot<V, VarRow<Id, V>> {
        return fx.op<V>({ kind: "get" });
      }

      static set(value: V): Kyoot<void, VarRow<Id, V>> {
        return fx.op<void>({ kind: "set", value });
      }

      static update(f: (value: V) => V): Kyoot<void, VarRow<Id, V>> {
        return fx.op<void>({ kind: "update", f });
      }

      static run(initial: V) {
        const handle = fx.handle<V>({
          state: initial,
          onOp: (op, resume, value) => {
            switch (op.kind) {
              case "get":
                return resume(value);
              case "set":
                return resume(undefined, op.value);
              case "update":
                return resume(
                  undefined,
                  invoke(() => op.f(value)),
                );
            }
          },
          onSuccess: (a, value) => succeed([a, value]),
        });
        return <A, S extends Row & Partial<VarRow<Id, V>> = {}>(k: Kyoot<A, S>) =>
          handle<A, S, [A, V]>(k);
      }
    };
  };
}
