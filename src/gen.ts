import { genNode } from "./core.ts";
import type { AnyKyoot, Kyoot, RowsOf } from "./model.ts";
import type { MergeAll } from "./types.ts";

export function gen<A, Y extends AnyKyoot>(
  f: () => Generator<Y, A, unknown>,
): Kyoot<A, MergeAll<RowsOf<Y>>> {
  return genNode(f) as Kyoot<A, any>;
}
