import { KyootImpl } from "./core.ts";
import type { AnyKyoot, Kyoot, RowsOf } from "./model.ts";
import type { MergeAll, Simplify } from "./types.ts";

export function gen<A, Y extends AnyKyoot>(
  f: () => Generator<Y, A, unknown>,
): Kyoot<A, Simplify<MergeAll<RowsOf<Y>>>> {
  return new KyootImpl({ _tag: "gen", f });
}
