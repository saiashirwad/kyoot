import { invoke, makeOp, succeed } from "../core.ts";
import { makeHandler } from "../handler.ts";
import type { Kyoot } from "../model.ts";
import type { Row, Simplify } from "../types.ts";

export const defer = <A>(f: () => A): Kyoot<A, { sync: true }> =>
  makeOp("sync", f) as Kyoot<A, { sync: true }>;

export function run() {
  return <A, S extends Row & { sync: unknown }>(
    k: Kyoot<A, S>,
  ): Kyoot<A, Simplify<Omit<S, "sync">>> =>
    makeHandler({
      key: "sync",
      self: k,
      onOp: (f, resume) => resume(invoke(f)),
      onPure: (a) => succeed(a),
    });
}
