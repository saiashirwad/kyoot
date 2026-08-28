import { InterruptedError } from "./core.ts";
import { Machine, type Outcome } from "./machine.ts";
import { NodeSym, type AnyKyoot, type Kyoot, type Snapshot } from "./model.ts";
import type { Only, Row } from "./types.ts";

// The keys the async driver serves itself.
export type Served = "async" | "clock";
const served = (key: PropertyKey): key is Served => key === "async" || key === "clock";

const unhandledEffect = (edge: string, key: PropertyKey) =>
  new Error(`${edge} encountered unhandled effect '${String(key)}'`);

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
  // spawned by the op to inherit (see `inherit`). Only an op that collects
  // them has any.
  readonly handlers?: readonly Snapshot[];
  spawn<A>(k: Kyoot<A, any>): FiberHandle<A>;
}

export interface AsyncOp {
  execute(rt: AsyncRuntime): Promise<unknown>;
}

// Steps a fiber runs before it lets the event loop turn.
const STEP_BUDGET = 4096;

// A signal that never fires: the root fiber's parent, and what ops that run
// as cleanup see.
const NEVER = new AbortController().signal;

// `abort()` with no reason builds a DOMException, stack trace and all, on
// every call, and every fiber ends with one. One shared reason skips that.
const ABORTED = new DOMException("This operation was aborted", "AbortError");

const schedule: (f: () => void) => void =
  typeof setImmediate === "function" ? setImmediate : (f) => setTimeout(f, 0);

const realSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const onAbort = () => clearTimeout(t);
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

// The functions a wait settles through. One set serves every sequential
// wait; `generation` says which wait it is for, so a stale one is ignored.
// An interrupt retires the set, leaving stale promises tied to it.
interface Reactions {
  generation: number;
  readonly fulfilled: (value: unknown) => void;
  readonly rejected: (error: unknown) => void;
  readonly continued: () => void;
}

const reactionsFor = (fiber: Fiber<any>): Reactions => {
  const r: Reactions = {
    generation: 0,
    fulfilled: (value) => fiber.settle(r.generation, "resume", value),
    rejected: (error) => fiber.settle(r.generation, "raise", error),
    continued: () => fiber.settle(r.generation, "continue", undefined),
  };
  return r;
};

// One program, driven to its end: its machine, its abort signal, and the
// fibers it spawned. The handle a caller keeps holds the controller and the
// promise, not the program.
class Fiber<A> implements FiberHandle<A> {
  readonly promise: Promise<A>;
  readonly interrupt: () => void;
  private readonly controller = new AbortController();
  private readonly machine = new Machine();
  private readonly rt: AsyncRuntime;
  private readonly parent: Fiber<any> | undefined;
  private children: Set<Promise<unknown>> | undefined;
  private reactions = reactionsFor(this);
  private resolve!: (value: A) => void;
  private reject!: (error: unknown) => void;
  // Each wait owns a generation. An interrupt moves the machine on and
  // bumps it, so the stale wait cannot resume the fiber when it settles.
  private generation = 0;
  private waiting = false;
  // An interrupt is delivered once, at the next served op. Ops after that
  // are cleanup (finalizers) and run to completion with a live signal.
  private interrupted = false;

  constructor(k: Kyoot<A, any>, parent: Fiber<any> | undefined) {
    const { controller } = this;
    this.parent = parent;
    this.interrupt = () => controller.abort(ABORTED);
    this.rt = { signal: controller.signal, spawn: (k2) => this.spawn(k2) };
    const drive = new Promise<A>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.promise = drive.finally(() => this.close());
    controller.signal.addEventListener("abort", () => this.onAbort(), { once: true });
    parent?.controller.signal.addEventListener("abort", this.interrupt, { once: true });
    try {
      this.pump(this.machine.start(k, STEP_BUDGET));
    } catch (error) {
      this.reject(error);
    }
  }

  private spawn<B>(k: Kyoot<B, any>): FiberHandle<B> {
    const child = new Fiber(k, this);
    (this.children ??= new Set()).add(child.promise);
    return child;
  }

  // The program ended. Interrupt what it spawned and wait for it, then let
  // the parent forget this fiber.
  private async close(): Promise<void> {
    this.controller.abort(ABORTED);
    this.parent?.controller.signal.removeEventListener("abort", this.interrupt);
    this.machine.reset();
    if (this.children !== undefined && this.children.size > 0) {
      await Promise.allSettled(this.children);
    }
    this.parent?.children?.delete(this.promise);
  }

  // A wait ended; move the machine on, unless the wait is stale.
  settle(current: number, how: "resume" | "raise" | "continue", payload: unknown): void {
    if (current !== this.generation) return;
    this.waiting = false;
    try {
      const { machine } = this;
      this.pump(
        how === "resume"
          ? machine.resume(payload, STEP_BUDGET)
          : how === "raise"
            ? machine.raise(payload, STEP_BUDGET)
            : machine.continue(STEP_BUDGET),
      );
    } catch (error) {
      this.reject(error);
    }
  }

  private onAbort(): void {
    if (!this.waiting || this.interrupted) return;
    this.interrupted = true;
    this.waiting = false;
    this.reactions = reactionsFor(this);
    this.generation++;
    try {
      this.pump(this.machine.raise(new InterruptedError(), STEP_BUDGET));
    } catch (error) {
      this.reject(error);
    }
  }

  // Start a wait: the next settle must carry this generation.
  private wait(): void {
    this.waiting = true;
    this.reactions.generation = ++this.generation;
  }

  private pump(initial: Outcome): void {
    const { machine, rt, controller } = this;
    let outcome = initial;
    while (true) {
      if (outcome === "done") {
        this.resolve(machine.value as A);
        return;
      }

      if (outcome === "yielded") {
        this.wait();
        schedule(this.reactions.continued);
        return;
      }

      const { key, payload, handlers } = machine;
      if (!served(key)) {
        this.reject(unhandledEffect("fiber", key));
        return;
      }

      if (controller.signal.aborted && !this.interrupted) {
        this.interrupted = true;
        outcome = machine.raise(new InterruptedError(), STEP_BUDGET);
        continue;
      }

      const signal = this.interrupted ? NEVER : controller.signal;
      let work: Promise<unknown>;
      try {
        work =
          key === "clock"
            ? realSleep(payload as number, signal)
            : (payload as AsyncOp).execute(
                signal === rt.signal && handlers === undefined ? rt : { ...rt, signal, handlers },
              );
      } catch (error) {
        outcome = machine.raise(error, STEP_BUDGET);
        continue;
      }

      this.wait();
      void work.then(this.reactions.fulfilled, this.reactions.rejected);
      return;
    }
  }
}

export function runPromise<A, S extends Row>(k: Kyoot<A, S> & Only<S, Served>): Promise<A> {
  return runFiber<A>(k).promise;
}

export function runFiber<A>(k: Kyoot<A, any>): FiberHandle<A> {
  return new Fiber(k, undefined);
}
