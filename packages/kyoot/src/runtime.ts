import { InterruptedError } from "./core.ts";
import { Machine, type Outcome } from "./machine.ts";
import { NodeSym, type AnyKyoot, type HandlerNode, type Kyoot } from "./model.ts";
import type { Only, Row } from "./types.ts";

// The keys the async driver serves itself.
const SERVED = ["async", "clock"] as const;
export type Served = (typeof SERVED)[number];
const served = (key: PropertyKey): key is Served =>
  (SERVED as readonly PropertyKey[]).includes(key);

const unhandledEffect = (edge: string, key: PropertyKey) =>
  new Error(`${edge} encountered unhandled effect '${String(key)}'`);

// Shared by async ops that request inheritance but cross no handler frames.
export const EMPTY_HANDLERS: readonly HandlerNode[] = [];

// One machine serves every runSync in turn; a nested call, from inside a
// program, makes its own while the outer holds this one.
let spare: Machine | undefined;

export function runSync<A, S extends Row>(k: Kyoot<A, S> & Only<S>): A {
  // A plain value needs no machine.
  const node = k[NodeSym];
  if (node._tag === "pure") return node.a as A;
  const machine = spare ?? new Machine();
  spare = undefined;
  try {
    if (machine.start(k as AnyKyoot) === "done") return machine.value as A;
    throw unhandledEffect("runSync", machine.key);
  } finally {
    machine.reset();
    spare = machine;
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

function asyncDrive<A>(k: Kyoot<A, any>, parent: AsyncRuntime): FiberHandle<A> {
  const controller = new AbortController();
  const link = () => controller.abort();
  parent.signal.addEventListener("abort", link, { once: true });
  const children = new Set<Promise<unknown>>();
  const rt: AsyncRuntime = {
    signal: controller.signal,
    handlers: EMPTY_HANDLERS,
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
  const machine = new Machine();
  const drive = new Promise<A>((resolve, reject) => {
    // Each wait owns a generation. An interrupt moves the machine on and
    // bumps it, so the stale wait cannot resume the fiber when it settles.
    let generation = 0;
    let waiting = false;
    // An interrupt is delivered once, at the next served op. Ops after that
    // are cleanup (finalizers) and run to completion with a live signal.
    let interrupted = false;

    const pump = (initial: Outcome): void => {
      let outcome = initial;
      while (true) {
        if (outcome === "done") {
          resolve(machine.value as A);
          return;
        }

        if (outcome === "yielded") {
          waiting = true;
          const current = ++generation;
          void yieldNow().then(() => {
            if (current !== generation) return;
            waiting = false;
            try {
              pump(machine.continue(STEP_BUDGET));
            } catch (error) {
              reject(error);
            }
          });
          return;
        }

        const { key, payload, handlers } = machine;
        if (!served(key)) {
          reject(unhandledEffect("fiber", key));
          return;
        }

        if (controller.signal.aborted && !interrupted) {
          interrupted = true;
          outcome = machine.raise(new InterruptedError(), STEP_BUDGET);
          continue;
        }

        const signal = interrupted ? NEVER : controller.signal;
        let work: Promise<unknown>;
        try {
          work =
            key === "clock"
              ? realSleep(payload as number, signal)
              : (payload as AsyncOp).execute(
                  signal === rt.signal && handlers === rt.handlers
                    ? rt
                    : { ...rt, signal, handlers },
                );
        } catch (error) {
          outcome = machine.raise(error, STEP_BUDGET);
          continue;
        }

        waiting = true;
        const current = ++generation;
        void work.then(
          (value) => {
            if (current !== generation) return;
            waiting = false;
            try {
              pump(machine.resume(value, STEP_BUDGET));
            } catch (error) {
              reject(error);
            }
          },
          (error: unknown) => {
            if (current !== generation) return;
            waiting = false;
            try {
              pump(machine.raise(error, STEP_BUDGET));
            } catch (defect) {
              reject(defect);
            }
          },
        );
        return;
      }
    };

    controller.signal.addEventListener(
      "abort",
      () => {
        if (!waiting || interrupted) return;
        interrupted = true;
        waiting = false;
        generation++;
        try {
          pump(machine.raise(new InterruptedError(), STEP_BUDGET));
        } catch (error) {
          reject(error);
        }
      },
      { once: true },
    );

    try {
      pump(machine.start(k, STEP_BUDGET));
    } catch (error) {
      reject(error);
    }
  });
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
