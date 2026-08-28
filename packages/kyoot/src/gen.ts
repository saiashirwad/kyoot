import { genNode } from "./core.ts";
import type { AnyKyoot, Kyoot, RowsOf } from "./model.ts";
import type { MergeAll } from "./types.ts";

// A fresh generator per run; the machine keeps it as a frame on its stack.
export function gen<A, Y extends AnyKyoot>(
  f: () => Generator<Y, A, unknown>,
): Kyoot<A, MergeAll<RowsOf<Y>>> {
  return genNode(f as () => Generator<AnyKyoot, unknown, unknown>) as Kyoot<A, any>;
}
