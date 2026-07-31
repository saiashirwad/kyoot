import { callUser, opKyoot, pureKyoot, type AnyKyoot, type Kyoot } from '../core.ts'
import { makeHandler } from '../handler.ts'
import type { Row, Simplify } from '../types.ts'

// Sync — suspended side effects. `defer` captures a thunk as an op so the
// effect is visible in the row; `run` executes deferred thunks and removes
// the slot, so programs whose only impurity is deferred can still reach
// runSync (which only accepts an empty row).

export function defer<A>(f: () => A): Kyoot<A, { sync: true }> {
  return opKyoot('sync', f) as Kyoot<A, { sync: true }>
}

export function run() {
  return <A, S extends Row & { sync: unknown }>(
    k: Kyoot<A, S>,
  ): Kyoot<A, Simplify<Omit<S, 'sync'>>> =>
    makeHandler({
      key: 'sync',
      self: k as AnyKyoot,
      onOp: (f: () => unknown, resume) => resume(callUser(f)),
      onPure: (a) => pureKyoot(a),
    }) as Kyoot<A, Simplify<Omit<S, 'sync'>>>
}
