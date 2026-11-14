import type { Kyoot as KyootType } from "../model.ts";
import { Kyoot, type Step } from "../index.ts";
import type { Only, Row } from "../types.ts";

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
  spawn<A>(k: KyootType<A, any>): FiberHandle<A>;
}

export interface AsyncOp {
  execute(rt: AsyncRuntime): Promise<unknown>;
}

const OPTIONS = { budget: 4096 };

const NEVER = new AbortController().signal;

const ABORTED = new DOMException("This operation was aborted", "AbortError");

const schedule: (f: () => void) => void =
  typeof setImmediate === "function" ? setImmediate : (f) => setTimeout(f, 0);

const tick = (): Promise<void> => new Promise(schedule);

class Fiber<A> implements FiberHandle<A> {
  readonly promise: Promise<A>;
  readonly interrupt: () => void;
  private readonly controller = new AbortController();
  private readonly rt: AsyncRuntime;
  private readonly parent: Fiber<any> | undefined;
  private children: Set<Promise<unknown>> | undefined;
  private wake: ((error: unknown) => void) | undefined;
  private exit: { readonly error: unknown } | undefined;

  constructor(k: KyootType<A, any>, parent: Fiber<any> | undefined) {
    const { controller } = this;
    this.parent = parent;
    this.interrupt = () => controller.abort(ABORTED);
    this.rt = { signal: controller.signal, spawn: (k2) => this.spawn(k2) };
    controller.signal.addEventListener("abort", () => this.wake?.(new InterruptedError()), {
      once: true,
    });
    parent?.controller.signal.addEventListener("abort", this.interrupt, {
      once: true,
    });
    this.promise = this.drive(k).finally(() => this.close());
  }

  private spawn<B>(k: KyootType<B, any>): FiberHandle<B> {
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

  // Interruptible until the fiber starts exiting; finalizers then run to completion.
  private wait(work: Promise<unknown>): Promise<unknown> {
    if (this.exit !== undefined) return work;
    return new Promise((resolve, reject) => {
      this.wake = reject;
      work.then(resolve, reject);
    });
  }

  private async drive(k: KyootType<A, any>): Promise<A> {
    const { rt, controller } = this;
    let s: Step<unknown, Row, true> = Kyoot.step(k as KyootType<unknown, Row>, OPTIONS);
    while (!s.done) {
      if (s.yielded) {
        try {
          await this.wait(tick());
        } catch (error) {
          this.exit = { error };
          s = s.cancel();
          continue;
        }
        s = s.continue();
        continue;
      }
      if (s.key !== "async") {
        this.exit = {
          error: new Error(`fiber encountered unhandled effect '${String(s.key)}'`),
        };
        s = s.cancel();
        continue;
      }
      if (controller.signal.aborted && this.exit === undefined) {
        this.exit = { error: new InterruptedError() };
        s = s.cancel();
        continue;
      }
      const signal = this.exit === undefined ? controller.signal : NEVER;
      let value: unknown;
      let failed = false;
      try {
        value = await this.wait(
          (s.payload as AsyncOp).execute(signal === rt.signal ? rt : { ...rt, signal }),
        );
      } catch (error) {
        failed = true;
        value = error;
      }
      this.wake = undefined;
      if (!failed) s = s.resume(value as never);
      else if (value instanceof InterruptedError) {
        this.exit = { error: value };
        s = s.cancel();
      } else s = s.raise(value);
    }
    if (this.exit !== undefined) throw this.exit.error;
    return s.value as A;
  }
}

export function runPromise<A, S extends Row>(k: KyootType<A, S> & Only<S, "async">): Promise<A> {
  return runFiber<A, S>(k).promise;
}

export function runFiber<A, S extends Row>(k: KyootType<A, S> & Only<S, "async">): FiberHandle<A> {
  return new Fiber(k, undefined);
}
