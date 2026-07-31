import { KyootImpl, type AnyKyoot, type Kyoot } from './core.ts'
import type { MergeAll, RowsOf, Simplify } from './types.ts'

export function gen<A, Y extends AnyKyoot>(
  f: () => Generator<Y, A, unknown>,
): Kyoot<A, Simplify<MergeAll<RowsOf<Y>>>> {
  return new KyootImpl({ _tag: 'gen', f: f as () => Generator<AnyKyoot, any, unknown> })
}
