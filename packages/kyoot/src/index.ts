// Handler naming. A handler is named for what it does to the effect it discharges.
//  - `X.run` is the default (or only) handler: it runs the program with X discharged.
//  - Alternatives are named by behaviour, one name per behaviour across effects: `live` (real
//    world), `manual`/`virtual`/`seeded` (controlled), `print` (to the console), `forEach(f)`,
//    `collect`, `discard`; `provide` supplies a service.
//  - Anything that is not a handler is not named like one (`Retry.retry`, `Mode.system`).

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
