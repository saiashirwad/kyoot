import { DefectError, EscapedOp, InterruptedError, invokeAsync, stepAll } from "./core.ts";
import type { AnyKyoot, Kyoot } from "./model.ts";

export function runSync<A>(k: Kyoot<A, {}>): A {
  try {
    return stepAll(k as AnyKyoot) as A;
  } catch (e) {
    if (e instanceof DefectError) throw e.defect;
    if (e instanceof EscapedOp) {
      throw new Error(`runSync encountered unhandled effect '${String(e.key)}'`);
    }
    throw e;
  }
}

export interface FiberHandle {
  readonly promise: Promise<unknown>;
  readonly interrupt: () => void;
}

export interface AsyncRuntime {
  readonly signal: AbortSignal;
  spawn(k: AnyKyoot): FiberHandle;
}

export interface AsyncOp {
  execute(rt: AsyncRuntime): Promise<unknown>;
}

const raceSignal = <T>(
  p: Promise<T>,
  signal: AbortSignal,
): Promise<{ readonly done: true; readonly value: T } | { readonly done: false }> => {
  if (signal.aborted) return Promise.resolve({ done: false });
  return Promise.race([
    p.then((value) => ({ done: true as const, value })),
    new Promise<{ done: false }>((resolve) => {
      signal.addEventListener("abort", () => resolve({ done: false }), { once: true });
    }),
  ]);
};

export function asyncDrive(k: AnyKyoot, parent: AsyncRuntime): FiberHandle {
  const controller = new AbortController();
  const link = () => controller.abort();
  parent.signal.addEventListener("abort", link, { once: true });
  const children = new Set<Promise<unknown>>();
  const rt: AsyncRuntime = {
    signal: controller.signal,
    spawn: (k2) => {
      const h = asyncDrive(k2, rt);
      children.add(h.promise);
      void h.promise.then(
        () => children.delete(h.promise),
        () => children.delete(h.promise),
      );
      return h;
    },
  };
  const drive = (async (): Promise<unknown> => {
    let current = k;
    while (true) {
      try {
        return stepAll(current);
      } catch (e) {
        if (e instanceof EscapedOp && e.key === "async") {
          const raced = await raceSignal(
            invokeAsync(() => (e.payload as AsyncOp).execute(rt)),
            rt.signal,
          );
          current = raced.done ? e.resume(raced.value) : e.resumeError(new InterruptedError());
        } else {
          throw e;
        }
      }
    }
  })();
  const settle = async () => {
    controller.abort();
    parent.signal.removeEventListener("abort", link);
    await Promise.allSettled(children);
  };
  const promise = drive.then(
    async (v) => {
      await settle();
      return v;
    },
    async (e: unknown) => {
      await settle();
      throw e;
    },
  );
  return { promise, interrupt: () => controller.abort() };
}

export function runPromise<A>(k: Kyoot<A, {}>): Promise<A>;
export function runPromise<A>(k: Kyoot<A, { async: true }>): Promise<A>;
export function runPromise<A>(k: AnyKyoot): Promise<A> {
  const seed: AsyncRuntime = {
    signal: new AbortController().signal,
    spawn: (k2) => asyncDrive(k2, seed),
  };
  return (asyncDrive(k as AnyKyoot, seed).promise as Promise<A>).catch((e: unknown): never => {
    if (e instanceof DefectError) throw e.defect;
    if (e instanceof EscapedOp) {
      throw new Error(`runPromise encountered unhandled effect '${String(e.key)}'`);
    }
    throw e;
  });
}
