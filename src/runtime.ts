import { DefectError, EscapedOp, invokeAsync, stepAll } from "./core.ts";
import type { AnyKyoot, Kyoot } from "./model.ts";

export function runSync<A>(k: Kyoot<A, {}>): A {
  try {
    return stepAll(k as AnyKyoot) as A;
  } catch (e) {
    if (e instanceof DefectError) throw e.defect;
    if (e instanceof EscapedOp) {
      throw new Error(`runSync encountered unhandled effect '${e.key}'`);
    }
    throw e;
  }
}

export interface AsyncRuntime {
  readonly signal: AbortSignal;
  spawn(k: AnyKyoot): { readonly promise: Promise<unknown> };
}

export interface AsyncOp {
  execute(rt: AsyncRuntime): Promise<unknown>;
}

export async function asyncDrive(k: AnyKyoot, rt: AsyncRuntime): Promise<unknown> {
  let current = k;
  while (true) {
    try {
      return stepAll(current);
    } catch (e) {
      if (e instanceof EscapedOp && e.key === "async") {
        const v = await invokeAsync(() => (e.payload as AsyncOp).execute(rt));
        current = e.resume(v);
      } else {
        throw e;
      }
    }
  }
}

export function runPromise<A>(k: Kyoot<A, {}>): Promise<A>;
export function runPromise<A>(k: Kyoot<A, { async: true }>): Promise<A>;
export function runPromise<A>(k: AnyKyoot): Promise<A> {
  const controller = new AbortController();
  const rt: AsyncRuntime = {
    signal: controller.signal,
    spawn: (k2) => ({ promise: asyncDrive(k2, rt) }),
  };
  return (asyncDrive(k as AnyKyoot, rt) as Promise<A>).catch((e: unknown): never => {
    if (e instanceof DefectError) throw e.defect;
    if (e instanceof EscapedOp) {
      throw new Error(`runPromise encountered unhandled effect '${e.key}'`);
    }
    throw e;
  });
}
