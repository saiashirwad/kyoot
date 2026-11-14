import { gen, succeed } from "./core.ts";
import type { Kyoot as KyootType } from "./model.ts";
import { runSync, step } from "./step.ts";
import type { Row } from "./types.ts";

export { catchDefect, effect, ensuring } from "./core.ts";
export type { Handle, Intercept, Resume } from "./core.ts";
export type { Done, Pending, Step } from "./step.ts";
export type { Answer, MergeAll, Only, Op, Payload, Row } from "./types.ts";
export type { RowsOf } from "./model.ts";

export type Kyoot<A, S extends Row = {}> = KyootType<A, S>;
export const Kyoot = { succeed, gen, runSync, step };
