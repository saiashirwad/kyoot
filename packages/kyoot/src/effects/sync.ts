import {
  makeIntercept,
  makeOp,
  type DependentRequirement,
  unsafeMakeHandler,
  type Hooks,
} from "../core.ts";
import type { AnyKyoot, Kyoot } from "../model.ts";
import type { Row } from "../types.ts";

declare const family: unique symbol;
export type SyncRow = { sync: DependentRequirement<() => unknown, unknown, typeof family> };

export const defer = <A>(f: () => A): Kyoot<A, SyncRow> => makeOp("sync", f) as Kyoot<A, SyncRow>;

export const unsafeHandle =
  <
    St = undefined,
    ROp extends AnyKyoot = Kyoot<never, {}>,
    RDefect extends AnyKyoot = Kyoot<never, {}>,
    RInterrupt extends void | AnyKyoot = void,
  >(
    hooks: Hooks<() => unknown, unknown, St, {}, ROp, RDefect, RInterrupt>,
  ) =>
  <A, S extends Row & Partial<SyncRow>>(k: Kyoot<A, S>) =>
    unsafeMakeHandler("sync", k, hooks);

export const unsafeIntercept = makeIntercept<"sync", () => unknown, unknown, {}, SyncRow["sync"]>(
  "sync",
);

export const run = unsafeHandle({ onOp: (f, resume) => resume(f()) });
