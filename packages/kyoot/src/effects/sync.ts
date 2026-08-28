import { effect } from "../core.ts";
import type { Kyoot } from "../model.ts";

const sync = effect<() => unknown, unknown>()("sync");

export const defer = <A>(f: () => A) => sync(f) as Kyoot<A, { sync: () => unknown }>;

export const handle = sync.handle;

export const intercept = sync.intercept;

export const run = sync.handle({ onOp: (f, resume) => resume(f()) });
