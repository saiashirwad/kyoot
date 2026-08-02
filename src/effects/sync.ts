import { callUser, opKyoot, pureKyoot, type Kyoot } from "../core.ts";
import { makeHandler } from "../handler.ts";
import type { Row, Simplify } from "../types.ts";

export const defer = <A>(f: () => A): Kyoot<A, { sync: true }> =>
  opKyoot("sync", f) as Kyoot<A, { sync: true }>;

export function run() {
  return <A, S extends Row & { sync: unknown }>(
    k: Kyoot<A, S>,
  ): Kyoot<A, Simplify<Omit<S, "sync">>> =>
    makeHandler({
      key: "sync",
      self: k,
      onOp: (f, resume) => resume(callUser(f)),
      onPure: (a) => pureKyoot(a),
    });
}
