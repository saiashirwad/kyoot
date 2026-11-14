import { Machine, UnhandledEffectError, type Outcome } from "../machine.ts";
import type { AnyKyoot, Kyoot } from "../model.ts";
import type { Only, Row } from "../types.ts";
import type { ConcurrencyKey, Exit, Fiber, ForkRequest } from "./effects.ts";
import type { AsyncOp } from "./promise.ts";

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

// What the live driver answers itself: concurrency and time with real fibers and timers, "random"
// with Math.random, and promise interop ("async"). Everything else needs a handler.
export type LiveKey = ConcurrencyKey | "async" | "random";

// Machine steps a fiber runs before it lets timers and I/O in.
const BUDGET = 4096;

const NEVER = new AbortController().signal;

const ABORTED = new DOMException("This operation was aborted", "AbortError");

const later: (f: () => void) => unknown =
  typeof setImmediate === "function" ? setImmediate : (f) => setTimeout(f, 0);

const cancelLater: (t: any) => void =
  typeof clearImmediate === "function" ? clearImmediate : clearTimeout;

// What the machine does next (mode).
const START = 0;
const RESUME = 1;
const RAISE = 2;
const CANCEL = 3;
const CONTINUE = 4;

// Where a fiber is (status).
const READY = 0;
const RUNNING = 1;
const WAITING = 2;
const DRAINING = 3; // its body ended; waiting for its children
const DONE = 4;

// What a waiting fiber waits for (on).
const ON_PROMISE = 1;
const ON_TIMER = 2;
const ON_FIBER = 3;
const ON_TURN = 4;

const INTERRUPTED: Exit<never, never> = { ok: false, cause: { _tag: "Interrupted" } };

// Fibers ready to run. Wake-ups from promises and timers start a drain; a fiber that wakes another
// while running only queues it, so fibers never run nested.
const queue: LiveFiber[] = [];
let draining = false;

const wake = (f: LiveFiber) => {
  if (draining) {
    queue.push(f);
    return;
  }
  draining = true;
  try {
    f.step();
    for (let i = 0; i < queue.length; i++) queue[i]!.step();
  } finally {
    if (queue.length !== 0) queue.length = 0;
    draining = false;
  }
};

let ids = 0;

class LiveFiber implements Fiber<unknown, unknown> {
  readonly id = ids++;
  readonly name: string;
  readonly parent: LiveFiber | undefined;
  private readonly machine = new Machine();
  private program: AnyKyoot | undefined;
  private children: Set<LiveFiber> | undefined;
  private joiners: LiveFiber[] | undefined;
  private status = READY;
  private mode = START;
  private input: unknown;
  private on = 0;
  private interrupting = false;
  private cancelRequested = false;
  private failure: { readonly error: unknown } | undefined;
  private waitingOn: LiveFiber | undefined;
  private wantsExit = false;
  private timer: any;
  private controller: AbortController | undefined;
  private fulfilled: ((value: unknown) => void) | undefined;
  private rejected: ((error: unknown) => void) | undefined;
  private ready: (() => void) | undefined;
  exit: Exit<unknown, unknown> | undefined;
  done: ((exit: Exit<unknown, unknown>) => void) | undefined;

  constructor(program: AnyKyoot, parent: LiveFiber | undefined, name: string | undefined) {
    this.program = program;
    this.parent = parent;
    this.name = name ?? (parent === undefined ? "main" : `#${this.id}`);
  }

  step(): void {
    if (this.status !== READY) return;
    this.status = RUNNING;
    const m = this.machine;
    for (;;) {
      let outcome: Outcome;
      try {
        switch (this.mode) {
          case RESUME:
            outcome = m.resume(this.input, BUDGET);
            break;
          case START:
            outcome = m.start(this.program!, BUDGET);
            this.program = undefined;
            break;
          case RAISE:
            outcome = m.raise(this.input, BUDGET);
            break;
          case CANCEL:
            outcome = m.cancel(BUDGET);
            break;
          default:
            outcome = m.continue(BUDGET);
        }
      } catch (defect) {
        return this.finish({ ok: false, cause: { _tag: "Defect", defect } });
      }
      this.input = undefined;
      if (outcome === "done") return this.ended();
      let answered: boolean;
      if (outcome === "yielded") {
        this.mode = CONTINUE;
        answered = this.waitTurn();
      } else {
        answered = this.answer(m.key, m.payload);
      }
      if (this.cancelRequested) {
        // Interrupted from inside its own run (by code it called synchronously, like an executor).
        this.cancelRequested = false;
        this.stopWaiting();
        this.status = RUNNING;
        this.mode = CANCEL;
        continue;
      }
      if (!answered) return;
    }
  }

  // Answers the operation the machine stopped at. True when it set the next mode and input at once;
  // false when the fiber now waits (status WAITING, or READY and queued).
  private answer(key: PropertyKey, payload: unknown): boolean {
    switch (key) {
      case "async":
        return this.awaitPromise(payload as AsyncOp);
      case "fiber/fork": {
        const req = payload as ForkRequest;
        const child = new LiveFiber(req.program, this, req.name);
        (this.children ??= new Set()).add(child);
        // The child runs first, until it waits; then this fiber continues with its handle.
        queue.push(child);
        this.mode = RESUME;
        this.input = child;
        this.status = READY;
        queue.push(this);
        return false;
      }
      case "fiber/join":
        return this.join(payload, true);
      case "fiber/interrupt": {
        if (payload === undefined || payload === this) {
          if (this.interrupting) return this.resumeWith(undefined);
          this.interrupting = true;
          this.mode = CANCEL;
          return true;
        }
        if (payload instanceof LiveFiber) payload.interrupt();
        return this.join(payload, false);
      }
      case "fiber/yield":
        this.mode = RESUME;
        return this.waitTurn();
      case "clock/sleep": {
        this.mode = RESUME;
        this.status = WAITING;
        this.on = ON_TIMER;
        this.timer = setTimeout(this.wakeUp(), Math.max(0, payload as number));
        return false;
      }
      case "clock/now":
        return this.resumeWith(Date.now());
      case "random":
        return this.resumeWith(Math.random());
      case "fail":
        // A forked fiber's typed failure: run its finalizers, then end with it.
        if (this.parent === undefined) break;
        this.failure = { error: payload };
        this.mode = CANCEL;
        return true;
    }
    const hint =
      this.parent === undefined
        ? ""
        : " (in a forked fiber: handlers don't cross a fork; use Async.provide or fork's provide)";
    this.mode = RAISE;
    this.input = new UnhandledEffectError(`unhandled effect '${String(key)}'${hint}`);
    return true;
  }

  private resumeWith(value: unknown): true {
    this.mode = RESUME;
    this.input = value;
    return true;
  }

  private awaitPromise(op: AsyncOp): boolean {
    const signal = this.interrupting ? NEVER : (this.controller ??= new AbortController()).signal;
    try {
      op(signal).then(
        (this.fulfilled ??= this.onSettled(RESUME)),
        (this.rejected ??= this.onSettled(RAISE)),
      );
    } catch (error) {
      this.mode = RAISE;
      this.input = error;
      return true;
    }
    this.status = WAITING;
    this.on = ON_PROMISE;
    return false;
  }

  // One pair of callbacks per fiber, reused for every promise. Interrupting drops them, so a
  // stale promise that settles later is ignored.
  private onSettled(mode: typeof RESUME | typeof RAISE) {
    const settled = (value: unknown) => {
      if ((mode === RESUME ? this.fulfilled : this.rejected) !== settled) return;
      this.on = 0;
      this.mode = mode;
      this.input = value;
      this.status = READY;
      wake(this);
    };
    return settled;
  }

  private wakeUp() {
    return (this.ready ??= () => {
      if (this.status !== WAITING || (this.on !== ON_TIMER && this.on !== ON_TURN)) return;
      this.timer = undefined;
      this.on = 0;
      this.status = READY;
      wake(this);
    });
  }

  private waitTurn(): false {
    this.status = WAITING;
    this.on = ON_TURN;
    this.timer = later(this.wakeUp());
    return false;
  }

  private join(target: unknown, wantsExit: boolean): boolean {
    if (!(target instanceof LiveFiber) || target === this) {
      this.mode = RAISE;
      this.input = new Error(
        target === this ? "a fiber cannot wait for itself" : `not a fiber: ${String(target)}`,
      );
      return true;
    }
    if (target.status === DONE) return this.resumeWith(wantsExit ? target.exit : undefined);
    this.status = WAITING;
    this.on = ON_FIBER;
    this.waitingOn = target;
    this.wantsExit = wantsExit;
    (target.joiners ??= []).push(this);
    return false;
  }

  private stopWaiting(): void {
    switch (this.on) {
      case ON_PROMISE:
        this.fulfilled = this.rejected = undefined;
        this.controller?.abort(ABORTED);
        break;
      case ON_TIMER:
        clearTimeout(this.timer);
        this.timer = undefined;
        break;
      case ON_TURN:
        cancelLater(this.timer);
        this.timer = undefined;
        break;
      case ON_FIBER:
        this.waitingOn = undefined;
        break;
    }
    this.on = 0;
  }

  interrupt(): void {
    if (this.interrupting || this.status === DONE || this.status === DRAINING) return;
    this.interrupting = true;
    switch (this.status) {
      case READY:
        if (this.mode === START) {
          this.program = undefined;
          return this.finish(INTERRUPTED);
        }
        this.mode = CANCEL;
        this.input = undefined;
        return;
      case WAITING:
        this.stopWaiting();
        this.mode = CANCEL;
        this.status = READY;
        return wake(this);
      case RUNNING:
        this.cancelRequested = true;
    }
  }

  private ended(): void {
    if (this.failure !== undefined) {
      return this.finish({ ok: false, cause: { _tag: "Fail", error: this.failure.error } });
    }
    this.finish({ ok: true, value: this.machine.value });
  }

  // The body ended; children go first (structured concurrency), then the fiber completes.
  private finish(exit: Exit<unknown, unknown>): void {
    this.exit = this.interrupting ? INTERRUPTED : exit;
    this.on = 0;
    const children = this.children;
    if (children !== undefined && children.size > 0) {
      this.status = DRAINING;
      for (const child of [...children]) child.interrupt();
      if (this.status !== DRAINING || children.size > 0) return;
    }
    this.complete();
  }

  private complete(): void {
    this.status = DONE;
    const exit = this.exit!;
    const joiners = this.joiners;
    if (joiners !== undefined) {
      this.joiners = undefined;
      for (const j of joiners) {
        if (j.waitingOn !== this) continue;
        j.waitingOn = undefined;
        j.on = 0;
        j.mode = RESUME;
        j.input = j.wantsExit ? exit : undefined;
        j.status = READY;
        wake(j);
      }
    }
    const parent = this.parent;
    if (parent !== undefined) {
      const siblings = parent.children!;
      siblings.delete(this);
      if (parent.status === DRAINING && siblings.size === 0) parent.complete();
    }
    this.done?.(exit);
  }
}

const start = <A>(k: AnyKyoot, resolve: (a: A) => void, reject: (e: unknown) => void) => {
  const main = new LiveFiber(k, undefined, undefined);
  main.done = (exit) => {
    if (exit.ok) return resolve(exit.value as A);
    const cause = exit.cause;
    reject(
      cause._tag === "Defect"
        ? cause.defect
        : cause._tag === "Fail"
          ? cause.error
          : new InterruptedError(),
    );
  };
  wake(main);
  return main;
};

/**
 * Runs a program on real fibers and timers. The driver answers fiber/*, clock/*, random and
 * promise interop ("async") for the program and every fiber it forks; handlers answer the rest.
 * The same program runs unchanged under Sim.run, which answers the same effects deterministically.
 */
export function runPromise<A, S extends Row>(k: Kyoot<A, S> & Only<S, LiveKey>): Promise<A> {
  return new Promise<A>((resolve, reject) => void start(k as AnyKyoot, resolve, reject));
}

export function runFiber<A, S extends Row>(k: Kyoot<A, S> & Only<S, LiveKey>): FiberHandle<A> {
  let main!: LiveFiber;
  const promise = new Promise<A>((resolve, reject) => {
    main = start(k as AnyKyoot, resolve, reject);
  });
  return { promise, interrupt: () => main.interrupt() };
}
