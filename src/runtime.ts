import { EscapedOp, InterruptedError, stepAll } from "./core.ts";
import type { AnyKyoot, Kyoot } from "./model.ts";
import type { Only, Row } from "./types.ts";

function rethrowAtEdge(e: unknown, edge: string): never {
  if (e instanceof EscapedOp) {
    throw new Error(`${edge} encountered unhandled effect '${String(e.key)}'`);
  }
  throw e;
}

export function runSync<A, S extends Row>(k: Kyoot<A, S> & Only<S>): A {
  try {
    return stepAll(k as AnyKyoot) as A;
  } catch (e) {
    rethrowAtEdge(e, "runSync");
  }
}

export interface FiberHandle<A = unknown> {
  readonly promise: Promise<A>;
  readonly interrupt: () => void;
}

export interface AsyncRuntime {
  readonly signal: AbortSignal;
  spawn<A>(k: Kyoot<A, any>): FiberHandle<A>;
}

export interface AsyncOp {
  execute(rt: AsyncRuntime): Promise<unknown>;
}

const realSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => clearTimeout(t), { once: true });
  });

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

export function asyncDrive<A>(k: Kyoot<A, any>, parent: AsyncRuntime): FiberHandle<A> {
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
  const drive = (async (): Promise<A> => {
    let current: AnyKyoot = k;
    while (true) {
      try {
        return stepAll(current) as A;
      } catch (e) {
        if (!(e instanceof EscapedOp) || (e.key !== "async" && e.key !== "clock")) throw e;
        const work =
          e.key === "async"
            ? (e.payload as AsyncOp).execute(rt)
            : realSleep(e.payload as number, rt.signal);
        const raced = await raceSignal(work, rt.signal);
        current = raced.done ? e.resume(raced.value) : e.resumeError(new InterruptedError());
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

export function runPromise<A, S extends Row>(
  k: Kyoot<A, S> & Only<S, "async" | "clock">,
): Promise<A>;
export function runPromise<A>(k: AnyKyoot): Promise<A> {
  const seed: AsyncRuntime = {
    signal: new AbortController().signal,
    spawn: (k2) => asyncDrive(k2, seed),
  };
  return asyncDrive(k, seed).promise.catch((e: unknown): never => rethrowAtEdge(e, "runPromise"));
}
