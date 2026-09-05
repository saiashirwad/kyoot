import { effect, makeHandler, succeed, type Cell } from "../core.ts";
import type {
  KnownOperationsOf,
  Kyoot,
  MergeOperations,
  Operation,
  RemoveOperations,
  RowOf,
} from "../model.ts";
import type { MergeAll, Remove, Row } from "../types.ts";

type VarRow<Id extends string, V> = {
  [K in `var/${Id}`]: V;
};

export type VarOp<V> =
  | { readonly kind: "get" }
  | { readonly kind: "set"; readonly value: V }
  | { readonly kind: "update"; readonly f: (value: V) => V };

type VarKey<Id extends string> = `var/${Id}`;
type VarOperation<Id extends string, V, A> = Operation<VarKey<Id>, VarOp<V>, A>;
type VarAnswer<V, O extends VarOp<V>> = O extends { readonly kind: "get" } ? V : void;
type VarNext<Id extends string, V> = <O extends VarOp<V>>(
  op: O,
) => Kyoot<VarAnswer<V, O>, VarRow<Id, V>, VarOperation<Id, V, VarAnswer<V, O>>>;
type VarHandler<Id extends string, V, K extends VarOp<V>["kind"], St> = (
  op: Extract<VarOp<V>, { readonly kind: K }>,
  next: VarNext<Id, V>,
  state: St,
) => Kyoot<VarAnswer<V, Extract<VarOp<V>, { readonly kind: K }>>, any, any>;
export type VarHandlerTable<Id extends string, V, St = undefined> = {
  readonly [K in VarOp<V>["kind"]]?: VarHandler<Id, V, K, St>;
};
type HandlerPrograms<T> = T[keyof T] extends infer F
  ? F extends (...args: any[]) => infer R
    ? R
    : never
  : never;
type ForwardedRow<Id extends string, V, T> =
  Exclude<VarOp<V>["kind"], keyof T> extends never ? never : VarRow<Id, V>;
type VarTransform<Id extends string, V, T extends VarHandlerTable<Id, V, any>> = <
  A,
  S extends Row & Partial<VarRow<Id, V>>,
  Ops,
>(
  k: Kyoot<A, S, Ops>,
) => Kyoot<
  A,
  MergeAll<Remove<S, VarKey<Id>> | RowOf<HandlerPrograms<T>> | ForwardedRow<Id, V, T>>,
  MergeOperations<RemoveOperations<Ops, VarKey<Id>>, KnownOperationsOf<HandlerPrograms<T>>>
>;
export interface VarIntercept<Id extends string, V> {
  <T extends VarHandlerTable<Id, V>>(table: T): VarTransform<Id, V, T>;
  <St, T extends VarHandlerTable<Id, V, St>>(cell: Cell<St>, table: T): VarTransform<Id, V, T>;
}

export interface Tag<Id extends string, V> {
  get(): Kyoot<V, VarRow<Id, V>, VarOperation<Id, V, V>>;
  set(value: V): Kyoot<void, VarRow<Id, V>, VarOperation<Id, V, void>>;
  update(f: (value: V) => V): Kyoot<void, VarRow<Id, V>, VarOperation<Id, V, void>>;
  readonly intercept: VarIntercept<Id, V>;
  run(
    initial: V,
  ): <A, S extends Row & Partial<VarRow<Id, V>>, Ops>(
    k: Kyoot<A, S, Ops>,
  ) => Kyoot<readonly [A, V], MergeAll<Remove<S, `var/${Id}`>>, RemoveOperations<Ops, `var/${Id}`>>;
}

export const tag =
  <V>() =>
  <const Id extends string>(id: Id): Tag<Id, V> => {
    const v = effect<VarOp<V>, V | undefined, {}, V>()(`var/${id}` as const);
    const get = v({ kind: "get" }) as Kyoot<V, VarRow<Id, V>, VarOperation<Id, V, V>>;
    const intercept = ((
      cellOrTable: Cell<unknown> | VarHandlerTable<Id, V, unknown>,
      maybeTable?: VarHandlerTable<Id, V, unknown>,
    ) => {
      const cell = maybeTable === undefined ? undefined : (cellOrTable as Cell<unknown>);
      const table = (maybeTable ?? cellOrTable) as VarHandlerTable<Id, V, unknown>;
      const dispatch = (op: VarOp<V>, next: VarNext<Id, V>, state: unknown) => {
        switch (op.kind) {
          case "get":
            return table.get?.(op, next, state) ?? next(op);
          case "set":
            return table.set?.(op, next, state) ?? next(op);
          case "update":
            return table.update?.(op, next, state) ?? next(op);
        }
      };
      return cell === undefined
        ? v.intercept(dispatch as never)
        : v.intercept(cell, dispatch as never);
    }) as VarIntercept<Id, V>;
    return {
      get: () => get,
      set: (value) =>
        v({ kind: "set", value }) as Kyoot<void, VarRow<Id, V>, VarOperation<Id, V, void>>,
      update: (f) =>
        v({ kind: "update", f }) as Kyoot<void, VarRow<Id, V>, VarOperation<Id, V, void>>,
      intercept,
      run: (initial) => (k) =>
        makeHandler(v.key, k, {
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
        }) as never,
    };
  };
