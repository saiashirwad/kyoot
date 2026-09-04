import { InterruptedError } from "./core.ts";
import { Machine, type Outcome } from "./machine.ts";
import { NodeSym, type AnyKyoot, type Kyoot, type Snapshot } from "./model.ts";
import type { Only, Row } from "./types.ts";

export type Served = "async" | "clock";
const served = (key: PropertyKey): key is Served => key === "async" || key === "clock";

const unhandledEffect = (edge: string, key: PropertyKey) =>
  new Error(`${edge} encountered unhandled effect '${String(key)}'`);

let spare: Machine | undefined;

export function runSync<A, S extends Row>(k: Kyoot<A, S> & Only<S>): A {
  const node = k[NodeSym];
  if (node._tag === "pure") return node.a as A;
  const machine = spare ?? new Machine();
  spare = undefined;
  try {
    if (machine.start(k as AnyKyoot) === "done") return machine.value as A;
    const unserved = (key: PropertyKey) => unhandledEffect("runSync", key);
    const error = unserved(machine.key);
    machine.discard(unserved);
    throw error;
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
  readonly handlers?: readonly Snapshot[];
  spawn<A>(k: Kyoot<A, any>): FiberHandle<A>;
}

export interface AsyncOp {
  execute(rt: AsyncRuntime): Promise<unknown>;
}

const STEP_BUDGET = 4096;

const NEVER = new AbortController().signal;

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
  private generation = 0;
  private waiting = false;
  private interrupted = false;
  private failure: unknown;

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

  private async close(): Promise<void> {
    this.controller.abort(ABORTED);
    this.parent?.controller.signal.removeEventListener("abort", this.interrupt);
    this.machine.reset();
    if (this.children !== undefined && this.children.size > 0) {
      await Promise.allSettled(this.children);
    }
    this.parent?.children?.delete(this.promise);
  }

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

  private wait(): void {
    this.waiting = true;
    this.reactions.generation = ++this.generation;
  }

  private pump(initial: Outcome): void {
    const { machine, rt, controller } = this;
    let outcome = initial;
    while (true) {
      if (outcome === "done") {
        // A recorded failure means something recovered from an unserved op and the program carried
        // on. It ran to the end, but it did not succeed: the op nothing could answer is the result.
        if (this.failure !== undefined) this.reject(this.failure);
        else this.resolve(machine.value as A);
        return;
      }

      if (outcome === "yielded") {
        this.wait();
        schedule(this.reactions.continued);
        return;
      }

      const { key, payload, handlers } = machine;
      if (!served(key)) {
        // Nothing can answer this op, so fail at it and keep driving: the finalizers still on the
        // stack -- including async ones, which is why this cannot be a plain reject -- get to run,
        // and a scope releasing itself can absorb the defect and finish the rest of its own. An
        // interrupt would be blunter than it needs to be here: it tears through those loops.
        const error = unhandledEffect("fiber", key);
        this.failure ??= error;
        this.interrupted = true;
        outcome = machine.raise(error, STEP_BUDGET);
        continue;
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
