import { makeHandler, op } from "../core.ts";
import type { Kyoot } from "../model.ts";
import type { Row } from "../types.ts";

export const defer = <A>(f: () => A) => op<A>()("sync", f as () => unknown);

export const run = <A, S extends Row & { sync?: () => unknown }>(k: Kyoot<A, S>) =>
  makeHandler({ effectKey: "sync", self: k, onOp: (f, resume) => resume(f()) });
