import { succeed } from "./core.ts";
import { gen } from "./gen.ts";
import type { Kyoot as KyootType } from "./model.ts";
import { runPromise, runSync } from "./runtime.ts";
import type { Row } from "./types.ts";

export { InterruptedError, KyootImpl, makeOp, succeed } from "./core.ts";
export { runPromise, runSync } from "./runtime.ts";
export { gen } from "./gen.ts";
export type { AsyncOp, AsyncRuntime, FiberHandle } from "./runtime.ts";
export type { Pipeable } from "./pipe.ts";
export { Cause, Result } from "./result.ts";
export type { Merge, MergeAll, Only, Row, Simplify, Unhandled } from "./types.ts";
export type { AnyKyoot, MapResult, RowsOf } from "./model.ts";

export * as Async from "./effects/async.ts";
export * as Emit from "./effects/emit.ts";
export * as Env from "./effects/env.ts";
export * as Fail from "./effects/fail.ts";
export * as Resource from "./effects/resource.ts";
export * as Sync from "./effects/sync.ts";
export * as Var from "./effects/var.ts";

export type Kyoot<A, S extends Row = {}> = KyootType<A, S>;
export const Kyoot = { succeed, gen, runSync, runPromise };
