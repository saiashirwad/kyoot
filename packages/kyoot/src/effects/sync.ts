import { effect } from "../core.ts";
import type { Kyoot, RowsOf } from "../model.ts";

const sync = effect<() => unknown, unknown>()("sync");

export const defer = <A>(f: () => A) => sync(f) as Kyoot<A, RowsOf<ReturnType<typeof sync>>>;

export const handle = sync.handle;

export const intercept = sync.intercept;

export const run = sync.handle({ tail: (f) => f() });
