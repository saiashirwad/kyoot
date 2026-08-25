import { KyootImpl, makeOp } from "../core.ts";
import type { Kyoot } from "../model.ts";
import type { Row, Simplify } from "../types.ts";

export const defer = <A>(f: () => A): Kyoot<A, { sync: true }> =>
  makeOp("sync", f) as Kyoot<A, { sync: true }>;

export const run = <A, S extends Row & { sync?: unknown } = {}>(
  k: Kyoot<A, S>,
): Kyoot<A, Simplify<Omit<S, "sync">>> =>
  new KyootImpl({
    _tag: "handler",
    effectKey: "sync",
    self: k,
    onOp: (f, resume) => resume(f()),
  });
