import { runPromise, runSync, succeed } from './core.ts'
import { gen } from './gen.ts'
import type { Kyoot as KyootType } from './core.ts'
import type { Row } from './types.ts'

export { runPromise, runSync, succeed } from './core.ts'
export { gen } from './gen.ts'
export type { AsyncOp, AsyncRuntime } from './core.ts'
export type { HandlerSpec } from './handler.ts'
export { makeHandler } from './handler.ts'
export { Cause, Result } from './result.ts'
export type { AsyncOnly, Empty, Handler, Merge, MergeAll, Row, RowsOf, Simplify } from './types.ts'

export * as Abort from './effects/abort.ts'
export * as Async from './effects/async.ts'
export * as Emit from './effects/emit.ts'
export * as Env from './effects/env.ts'
export * as Sync from './effects/sync.ts'
export * as Var from './effects/var.ts'

export type Kyoot<A, S extends Row = {}> = KyootType<A, S>
export const Kyoot = { succeed, gen, runSync, runPromise }
