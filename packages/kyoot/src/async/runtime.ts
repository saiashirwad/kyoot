import { Machine, type Outcome } from "../machine.ts";
import type { Kyoot, Snapshot } from "../model.ts";
import type { Only, Row } from "../types.ts";
import { live } from "./clock.ts";

export type Served = "async" | "clock";

export class InterruptedError extends Error {
  readonly _tag = "InterruptedError";
  constructor(message = "fiber interrupted") {
    super(message);
    this.name = "InterruptedError";
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
  readonly inherits?: boolean;
}

const STEP_BUDGET = 4096;

const NEVER = new AbortController().signal;

const ABORTED = new DOMException("This operation was aborted", "AbortError");

const schedule: (f: () => void) => void =
  typeof setImmediate === "function" ? setImmediate : (f) => setTimeout(f, 0);

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
  private exit: { readonly error: unknown } | undefined;

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
    this.step(() => this.machine.start(k, STEP_BUDGET));
  }

  private step(run: () => Outcome): void {
    try {
      this.pump(run());
    } catch (error) {
      this.reject(this.exit?.error ?? error);
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
    if (this.children !== undefined && this.children.size > 0) {
      await Promise.allSettled(this.children);
    }
    this.parent?.children?.delete(this.promise);
  }

  settle(current: number, how: "resume" | "raise" | "continue", payload: unknown): void {
    if (current !== this.generation) return;
    this.waiting = false;
    const { machine } = this;
    this.step(() =>
      how === "resume"
        ? machine.resume(payload, STEP_BUDGET)
        : how === "raise"
          ? this.raise(payload)
          : machine.continue(STEP_BUDGET),
    );
  }

  private cancel(error: unknown): Outcome {
    this.exit = { error };
    return this.machine.cancel(STEP_BUDGET);
  }

  private raise(error: unknown): Outcome {
    return error instanceof InterruptedError
      ? this.cancel(error)
      : this.machine.raise(error, STEP_BUDGET);
  }

  private onAbort(): void {
    if (!this.waiting || this.exit !== undefined) return;
    this.waiting = false;
    this.reactions = reactionsFor(this);
    this.generation++;
    this.step(() => this.cancel(new InterruptedError()));
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
        if (this.exit === undefined) this.resolve(machine.value as A);
        else this.reject(this.exit.error);
        return;
      }

      if (outcome === "yielded") {
        this.wait();
        schedule(this.reactions.continued);
        return;
      }

      const { key, payload } = machine;
      if (key !== "async") {
        outcome = this.cancel(new Error(`fiber encountered unhandled effect '${String(key)}'`));
        continue;
      }

      if (controller.signal.aborted && this.exit === undefined) {
        outcome = this.cancel(new InterruptedError());
        continue;
      }

      const signal = this.exit === undefined ? controller.signal : NEVER;
      const op = payload as AsyncOp;
      let work: Promise<unknown>;
      try {
        work = op.execute(
          signal === rt.signal && !op.inherits
            ? rt
            : { ...rt, signal, handlers: op.inherits ? machine.snapshot() : undefined },
        );
      } catch (error) {
        outcome = this.raise(error);
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
  return new Fiber(live(k), undefined);
}
