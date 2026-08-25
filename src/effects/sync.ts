import { makeHandler, makeOp } from "../core.ts";
import type { Kyoot } from "../model.ts";
import type { Row } from "../types.ts";

export const defer = <A>(f: () => A): Kyoot<A, { sync: true }> =>
  makeOp("sync", f) as Kyoot<A, { sync: true }>;

export const run = <A, S extends Row & { sync?: unknown }>(k: Kyoot<A, S>) =>
  makeHandler({
    effectKey: "sync",
    self: k,
    onOp: (f: () => unknown, resume) => resume(f()),
  });
