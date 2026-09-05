import { InterruptedError } from "./core.ts";
import { Scope, ScopeAwait, type ScopeAwaitOp } from "./internal/scope.ts";
import { Machine, type Outcome } from "./machine.ts";
import { NodeSym, type AnyKyoot, type Kyoot, type Snapshot } from "./model.ts";
import type { Only, Row } from "./types.ts";

export type Served = "async" | "clock";
const served = (key: PropertyKey): key is Served | typeof ScopeAwait =>
  key === "async" || key === "clock" || key === ScopeAwait;

const unhandledEffect = (edge: string, key: PropertyKey) =>
  new Error(`${edge} encountered unhandled effect '${String(key)}'`);

let spare: Machine | undefined;

export function runSync<A, S extends Row>(k: Kyoot<A, S> & Only<S>): A {
  const node = k[NodeSym];
  if (node._tag === "pure") return node.a as A;
  const machine = spare ?? new Machine();
  spare = undefined;
  try {
    let outcome = machine.start(k as AnyKyoot);
    while (outcome !== "done") {
      outcome =
        outcome === "yielded"
          ? machine.continue()
          : machine.raise(unhandledEffect("runSync", machine.key));
    }
    return machine.value as A;
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
  const reactions: Reactions = {
    generation: 0,
    fulfilled: (value) => fiber.settle(reactions.generation, "resume", value),
    rejected: (error) => fiber.settle(reactions.generation, "raise", error),
    continued: () => fiber.settle(reactions.generation, "continue", undefined),
  };
  return reactions;
};

const ownerFrom = (handlers: readonly Snapshot[] | undefined, root: Scope): Scope => {
  if (handlers !== undefined) {
    for (const handler of handlers) if (handler.state instanceof Scope) return handler.state;
  }
  return root;
};

type Exit<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: unknown };

class Fiber<A> implements FiberHandle<A> {
  readonly promise: Promise<A>;
  readonly interrupt: () => void;
  private readonly controller = new AbortController();
  private readonly machine = new Machine();
  private readonly root = new Scope();
  private readonly rt: AsyncRuntime;
  private readonly parent: Fiber<any> | undefined;
  private reactions = reactionsFor(this);
  private resolve!: (value: A) => void;
  private reject!: (error: unknown) => void;
  private generation = 0;
  private waiting = false;
  private interruptRequested = false;
  private interruptDelivered = false;
  private finishing = false;

  constructor(k: Kyoot<A, any>, parent: Fiber<any> | undefined) {
    const { controller } = this;
    this.parent = parent;
    this.interrupt = () => controller.abort(ABORTED);
    this.rt = { signal: controller.signal, spawn: (child) => this.spawn(child, this.root) };
    this.promise = new Promise<A>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    controller.signal.addEventListener("abort", () => this.onAbort(), { once: true });
    parent?.controller.signal.addEventListener("abort", this.interrupt, { once: true });
    if (parent?.controller.signal.aborted) this.interrupt();
    try {
      this.pump(this.machine.start(k, STEP_BUDGET));
    } catch (error) {
      this.finish({ ok: false, error });
    }
  }

  private spawn<B>(k: Kyoot<B, any>, owner: Scope): FiberHandle<B> {
    const child = new Fiber(k, this);
    owner.own(child);
    return child;
  }

  private finish(exit: Exit<A>): void {
    if (this.finishing) return;
    this.finishing = true;
    this.waiting = false;
    this.reactions = reactionsFor(this);
    this.generation++;
    this.controller.abort(ABORTED);
    const children = this.root.close().children;
    void Promise.resolve(children).then(() => {
      let settled = exit;
      try {
        this.machine.reset();
      } catch (error) {
        settled = { ok: false, error };
      }
      this.parent?.controller.signal.removeEventListener("abort", this.interrupt);
      if (settled.ok) this.resolve(settled.value);
      else this.reject(settled.error);
    });
  }

  settle(current: number, how: "resume" | "raise" | "continue", payload: unknown): void {
    if (current !== this.generation || this.finishing) return;
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
      this.finish({ ok: false, error });
    }
  }

  private onAbort(): void {
    this.interruptRequested = true;
    if (
      this.finishing ||
      !this.waiting ||
      this.interruptDelivered ||
      this.machine.interruptMasked
    ) {
      return;
    }
    this.deliverInterrupt();
  }

  private deliverInterrupt(): void {
    this.interruptDelivered = true;
    this.waiting = false;
    this.reactions = reactionsFor(this);
    this.generation++;
    try {
      this.pump(this.machine.raise(new InterruptedError(), STEP_BUDGET));
    } catch (error) {
      this.finish({ ok: false, error });
    }
  }

  private wait(): void {
    this.waiting = true;
    this.reactions.generation = ++this.generation;
  }

  private pump(initial: Outcome): void {
    const { machine, controller } = this;
    let outcome = initial;
    while (true) {
      if (outcome === "done") {
        if (this.interruptRequested && !this.interruptDelivered) {
          this.finish({ ok: false, error: new InterruptedError() });
        } else {
          this.finish({ ok: true, value: machine.value as A });
        }
        return;
      }

      if (this.interruptRequested && !this.interruptDelivered && !machine.interruptMasked) {
        this.interruptDelivered = true;
        outcome = machine.raise(new InterruptedError(), STEP_BUDGET);
        continue;
      }

      if (outcome === "yielded") {
        this.wait();
        schedule(this.reactions.continued);
        return;
      }

      const { key, payload, handlers } = machine;
      if (!served(key)) {
        outcome = machine.raise(unhandledEffect("fiber", key), STEP_BUDGET);
        continue;
      }

      const masked = machine.interruptMasked;
      const signal = this.interruptDelivered || masked ? NEVER : controller.signal;
      const owner = ownerFrom(handlers, this.root);
      const base = this.rt;
      const rt: AsyncRuntime =
        signal === base.signal && handlers === undefined && owner === this.root
          ? base
          : {
              ...base,
              signal,
              handlers,
              spawn: (child) => this.spawn(child, owner),
            };

      let work: Promise<unknown>;
      try {
        work =
          key === ScopeAwait
            ? (payload as ScopeAwaitOp).execute()
            : key === "clock"
              ? realSleep(payload as number, signal)
              : (payload as AsyncOp).execute(rt);
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
  return runFiber<A, S>(k).promise;
}

export function runFiber<A, S extends Row>(k: Kyoot<A, S> & Only<S, Served>): FiberHandle<A> {
  return new Fiber(k, undefined);
}
