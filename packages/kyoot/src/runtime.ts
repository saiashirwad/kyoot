import { EscapedOp, InterruptedError, stepAll, withBudget, yieldKey } from "./core.ts";
import type { AnyKyoot, HandlerNode, Kyoot } from "./model.ts";
import type { Only, Row } from "./types.ts";

// The keys the async driver serves itself; `yieldKey` is the driver's own.
const SERVED = ["async", "clock", yieldKey] as const;
export type Served = Exclude<(typeof SERVED)[number], symbol>;
const served = (key: PropertyKey) => (SERVED as readonly PropertyKey[]).includes(key);

const unhandledEffect = (edge: string, key: PropertyKey) =>
  new Error(`${edge} encountered unhandled effect '${String(key)}'`);

export function runSync<A, S extends Row>(k: Kyoot<A, S> & Only<S>): A {
  try {
    return withBudget(Infinity, () => stepAll(k as AnyKyoot)) as A;
  } catch (e) {
    if (e instanceof EscapedOp) throw unhandledEffect("runSync", e.key);
    throw e;
  }
}

export interface FiberHandle<A = unknown> {
  readonly promise: Promise<A>;
  readonly interrupt: () => void;
}

export interface AsyncRuntime {
  readonly signal: AbortSignal;
  // The handlers the op being served crossed, innermost first, for a fiber
  // spawned by the op to inherit (see `inherit`).
  readonly handlers?: readonly HandlerNode[];
  spawn<A>(k: Kyoot<A, any>): FiberHandle<A>;
}

export interface AsyncOp {
  execute(rt: AsyncRuntime): Promise<unknown>;
}

// Steps a fiber runs before it lets the event loop turn.
const STEP_BUDGET = 4096;

// A signal that never fires, for ops that run as cleanup.
const NEVER = new AbortController().signal;

// What a wait resolves with when the signal cuts it short.
const INTERRUPTED: unique symbol = Symbol("kyoot.interrupted");

const yieldNow = () =>
  new Promise<void>((resolve) => {
    if (typeof setImmediate === "function") setImmediate(resolve);
    else setTimeout(resolve, 0);
  });

const realSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const onAbort = () => clearTimeout(t);
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

// `p`, unless the signal fires first. The listener comes off either way.
const raceSignal = <T>(p: Promise<T>, signal: AbortSignal): Promise<T | typeof INTERRUPTED> => {
  if (signal.aborted) return Promise.resolve(INTERRUPTED);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(INTERRUPTED);
    signal.addEventListener("abort", onAbort, { once: true });
    const done = () => signal.removeEventListener("abort", onAbort);
    void p.then(
      (v) => (done(), resolve(v)),
      (err: unknown) => (done(), reject(err)),
    );
  });
};

function asyncDrive<A>(k: Kyoot<A, any>, parent: AsyncRuntime): FiberHandle<A> {
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
  // An interrupt is delivered once, at the next op. Ops after that are cleanup
  // (finalizers) and run to completion with a live signal.
  let interrupted = false;
  const interrupt = (e: EscapedOp) => {
    interrupted = true;
    return e.resumeError(new InterruptedError());
  };
  const serve = async (e: EscapedOp): Promise<AnyKyoot> => {
    const signal = interrupted ? NEVER : rt.signal;
    if (e.key === yieldKey) {
      await yieldNow();
      return signal.aborted ? interrupt(e) : e.resume(undefined);
    }
    try {
      const work =
        e.key === "clock"
          ? realSleep(e.payload as number, signal)
          : (e.payload as AsyncOp).execute({ ...rt, signal, handlers: e.handlers });
      const v = await raceSignal(work, signal);
      return v === INTERRUPTED ? interrupt(e) : e.resume(v);
    } catch (err) {
      return e.resumeError(err);
    }
  };
  const drive = (async (): Promise<A> => {
    let current: AnyKyoot = k;
    while (true) {
      try {
        return withBudget(STEP_BUDGET, () => stepAll(current)) as A;
      } catch (e) {
        if (!(e instanceof EscapedOp)) throw e;
        if (!served(e.key)) throw unhandledEffect("fiber", e.key);
        current = await serve(e);
      }
    }
  })();
  const settle = async () => {
    controller.abort();
    parent.signal.removeEventListener("abort", link);
    if (children.size > 0) await Promise.allSettled(children);
  };
  return { promise: drive.finally(settle), interrupt: () => controller.abort() };
}

export function runPromise<A, S extends Row>(k: Kyoot<A, S> & Only<S, Served>): Promise<A> {
  return runFiber<A>(k).promise;
}

export function runFiber<A>(k: Kyoot<A, any>): FiberHandle<A> {
  const seed: AsyncRuntime = {
    signal: new AbortController().signal,
    spawn: (k2) => asyncDrive(k2, seed),
  };
  return asyncDrive(k, seed);
}
