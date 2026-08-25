import { EscapedOp, Interp, InterruptedError, Status, stepAll } from "./core.ts";
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

export function asyncDrive(k: AnyKyoot, parent: AsyncRuntime): FiberHandle {
  const controller = new AbortController();
  const signal = controller.signal;
  const link = () => controller.abort();
  parent.signal.addEventListener("abort", link, { once: true });
  const children = new Set<Promise<unknown>>();
  const rt: AsyncRuntime = {
    signal,
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
  const drive = new Promise<unknown>((resolve, reject) => {
    const it = new Interp();
    // Bumped whenever the fiber moves on so a stale promise cannot resume it.
    let gen = 0;
    const pump = (): void => {
      while (it.status === Status.Suspended) {
        if (it.key !== "async") {
          reject(new EscapedOp(it.key, it.payload));
          return;
        }
        if (signal.aborted) {
          gen++;
          try {
            it.resumeError(new InterruptedError());
          } catch (e) {
            reject(e);
            return;
          }
          continue;
        }
        let p: Promise<unknown>;
        try {
          p = (it.payload as AsyncOp).execute(rt);
        } catch (e) {
          reject(e);
          return;
        }
        const g = gen;
        p.then(
          (v) => {
            if (g !== gen) return;
            gen++;
            try {
              it.resume(v);
            } catch (e) {
              reject(e);
              return;
            }
            pump();
          },
          (e) => {
            if (g !== gen) return;
            gen++;
            reject(e);
          },
        );
        return;
      }
      resolve(it.value);
    };
    signal.addEventListener(
      "abort",
      () => {
        if (it.status !== Status.Suspended) return;
        pump();
      },
      { once: true },
    );
    try {
      it.run(k);
    } catch (e) {
      reject(e);
      return;
    }
    pump();
  });
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

export function runPromise<A, S extends Row>(k: Kyoot<A, S> & Only<S, "async">): Promise<A>;
export function runPromise<A>(k: AnyKyoot): Promise<A> {
  const seed: AsyncRuntime = {
    signal: new AbortController().signal,
    spawn: (k2) => asyncDrive(k2, seed),
  };
  return (asyncDrive(k as AnyKyoot, seed).promise as Promise<A>).catch((e: unknown): never =>
    rethrowAtEdge(e, "runPromise"),
  );
}
