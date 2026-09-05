import type { Kyoot } from "../model.ts";
import { runFiber, type FiberHandle } from "../runtime.ts";

/** Internal edge for code that has proved its row constraint through a higher-level API. */
export const unsafeRunFiber = <A>(k: Kyoot<A, any>): FiberHandle<A> => runFiber(k as never);
