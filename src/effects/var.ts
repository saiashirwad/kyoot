import { invoke, makeOp, succeed } from "../core.ts";
import { makeHandler } from "../handler.ts";
import type { AnyKyoot, Kyoot } from "../model.ts";
import type { Row, Simplify } from "../types.ts";

// Var — local state. `run` returns [A, finalState]. Handler order is
// semantics: `Var.run` before `Abort.run` (pipe order) gives transactional
// state — a short-circuiting abort discards the Var frame, so the failure
// carries no state. The reverse order wraps the failure in [_, state], so
// state survives failure.

type GetVar = { readonly kind: "get" };

type VarOp =
  | GetVar
  | { readonly kind: "set"; readonly value: unknown }
  | { readonly kind: "update"; readonly f: (v: any) => unknown };

export function get<V>(): Kyoot<V, { var: V }> {
  return makeOp("var", { kind: "get" }) as Kyoot<V, { var: V }>;
}

export function set<V>(v: V): Kyoot<void, { var: V }> {
  return makeOp("var", { kind: "set", value: v } satisfies VarOp) as Kyoot<void, { var: V }>;
}

export function update<V>(f: (v: V) => V): Kyoot<void, { var: V }> {
  return makeOp("var", { kind: "update", f } satisfies VarOp) as Kyoot<void, { var: V }>;
}

export function run<V>(init: V) {
  return <A, S extends Row & { var: V }>(
    k: Kyoot<A, S>,
  ): Kyoot<[A, V], Simplify<Omit<S, "var">>> => {
    let state = init;
    return makeHandler({
      effectKey: "var",
      self: k as AnyKyoot,
      onOp: (op: VarOp, resume) => {
        switch (op.kind) {
          case "get":
            return resume(state);
          case "set":
            state = op.value as V;
            return resume(undefined);
          case "update":
            state = invoke(() => op.f(state)) as V;
            return resume(undefined);
        }
      },
      onPure: (a) => succeed([a, state]),
    }) as Kyoot<[A, V], Simplify<Omit<S, "var">>>;
  };
}
