import { KyootImpl } from "./core.ts";
import type { AnyKyoot, Kyoot, RowsOf } from "./model.ts";
import type { MergeAll, Simplify } from "./types.ts";

// The body must be pure between yields: all effects go through yielded
// ops. The interpreter relies on this to replay the generator when a
// handler resumes a continuation more than once (Choice).
export function gen<A, Y extends AnyKyoot>(
  f: () => Generator<Y, A, unknown>,
): Kyoot<A, Simplify<MergeAll<RowsOf<Y>>>> {
  return new KyootImpl({ _tag: "gen", factory: f, trace: null, cache: { live: null } });
}
