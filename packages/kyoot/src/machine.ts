import { InterruptedError, KEEP, KyootImpl, node, raise, succeed } from "./core.ts";
import type { AnyKyoot, HandlerHooks, RuntimeResume, Snapshot } from "./model.ts";

export type Outcome = "done" | "suspended" | "yielded";

const STALE = "resume used outside the operation it answers";

// A frame is whatever waits on the stack for the program above it to end, and it is
// told how that program ended, the way a generator is: `value` (next), `error` (throw)
// or `cancel` (return). Each may hand back a program to run in its place; `value`
// returning undefined passes the value on, `error` returning undefined lets the error
// keep falling, `cancel` returning undefined means there is nothing to clean up.
// A `map` sits on the stack as its function and a `flatMap` as its node; see `deliver`.
interface Frame {
  value?(v: unknown, m: Machine): AnyKyoot | undefined;
  error?(e: unknown, m: Machine): AnyKyoot | undefined;
  cancel?(m: Machine): AnyKyoot | undefined;
}

type Entry = Frame | KyootImpl<unknown> | ((a: unknown) => unknown);

class GenFrame implements Frame {
  readonly generator: Generator<AnyKyoot, unknown, unknown>;

  constructor(generator: Generator<AnyKyoot, unknown, unknown>) {
    this.generator = generator;
  }

  value(v: unknown, m: Machine): AnyKyoot {
    return this.step(this.generator.next(v), m);
  }

  error(e: unknown, m: Machine): AnyKyoot {
    return this.step(this.generator.throw(e), m);
  }

  cancel(m: Machine): AnyKyoot | undefined {
    const step = this.generator.return(undefined);
    return step.done ? undefined : this.step(step, m);
  }

  // Answers pure yields in place, spending budget as the machine would.
  private step(step: IteratorResult<AnyKyoot, unknown>, m: Machine): AnyKyoot {
    while (!step.done) {
      const yielded = node(step.value);
      if (yielded._tag !== "pure" || !m.spend()) {
        m.push(this);
        return step.value;
      }
      step = this.generator.next(yielded.a);
    }
    return succeed(step.value);
  }
}

class HandlerFrame implements Frame {
  readonly key: PropertyKey;
  readonly hooks: HandlerHooks;
  state: unknown;

  constructor(key: PropertyKey, hooks: HandlerHooks) {
    this.key = key;
    this.hooks = hooks;
    this.state = hooks.create === undefined ? hooks.initial : hooks.create();
  }

  value(v: unknown): AnyKyoot | undefined {
    const onReturn = this.hooks.onReturn;
    return onReturn === undefined ? undefined : onReturn(v, this.state);
  }
}

// Stands above the stack an op was performed on while its handler's program runs there.
// Below it, down to and including the handler, is the op's continuation: lookups pass
// over it, and if the program ends without resuming, it is cancelled.
class Mask implements Frame {
  readonly handler: HandlerFrame;
  readonly below: number;
  readonly index: number;

  constructor(handler: HandlerFrame, below: number, index: number) {
    this.handler = handler;
    this.below = below;
    this.index = index;
  }

  value(answer: unknown, m: Machine): AnyKyoot {
    return m.cancelTo(this.below, succeed(answer));
  }

  error(e: unknown, m: Machine): AnyKyoot {
    return m.cancelTo(this.below, raise(e));
  }
}

class CatchFrame implements Frame {
  readonly f: (d: unknown) => AnyKyoot;

  constructor(f: (d: unknown) => AnyKyoot) {
    this.f = f;
  }

  error(e: unknown): AnyKyoot {
    return this.f(e);
  }
}

class EnsureFrame implements Frame {
  readonly cleanup: AnyKyoot;

  constructor(cleanup: AnyKyoot) {
    this.cleanup = cleanup;
  }

  value(v: unknown): AnyKyoot {
    return this.cleanup.flatMap(() => succeed(v));
  }

  error(e: unknown): AnyKyoot {
    return this.cleanup.flatMap(() => raise(e));
  }

  cancel(): AnyKyoot {
    return this.cleanup;
  }
}

// Holds a cancellation's place while a frame's cleanup runs, then carries on with it.
// A cleanup that raises replaces the outcome the cancellation was heading for.
class Unwind implements Frame {
  readonly index: number;
  then: AnyKyoot;

  constructor(index: number, then: AnyKyoot) {
    this.index = index;
    this.then = then;
  }

  value(_: unknown, m: Machine): AnyKyoot {
    return m.cancelTo(this.index, this.then);
  }

  error(e: unknown, m: Machine): AnyKyoot {
    return m.cancelTo(this.index, raise(e));
  }
}

const resumer = (mask: Mask): RuntimeResume => {
  const resume = function (value: unknown, state?: unknown): AnyKyoot {
    return new KyootImpl("resume", mask, value, arguments.length > 1 ? state : KEEP);
  };
  resume.with = function (program: AnyKyoot, state?: unknown): AnyKyoot {
    return new KyootImpl("resumeWith", mask, program, arguments.length > 1 ? state : KEEP);
  };
  return resume;
};

export class Machine {
  private readonly stack: Entry[] = [];
  private current!: AnyKyoot;
  private remaining = Infinity;

  value: unknown;
  // The op the machine is suspended on: no handler on the stack answers it.
  key: PropertyKey = "";
  payload: unknown;
  private skip = 0;

  start(program: AnyKyoot, budget = Infinity): Outcome {
    this.current = program;
    return this.run(budget);
  }

  continue(budget = Infinity): Outcome {
    return this.run(budget);
  }

  resume(value: unknown, budget = Infinity): Outcome {
    this.current = succeed(value);
    return this.run(budget);
  }

  raise(error: unknown, budget = Infinity): Outcome {
    this.current = raise(error);
    return this.run(budget);
  }

  push(entry: Entry): void {
    this.stack.push(entry);
  }

  spend(): boolean {
    if (this.remaining <= 0) return false;
    this.remaining--;
    return true;
  }

  // The handlers a fiber forked here inherits, innermost first: those the op it is
  // suspended on could reach, less any marked to stay out.
  snapshot(): Snapshot[] {
    const out: Snapshot[] = [];
    const stack = this.stack;
    const key = this.key;
    let skip = this.skip;
    for (let i = stack.length - 1; i >= 0; i--) {
      const entry = stack[i];
      if (entry instanceof Mask) i = entry.below;
      else if (!(entry instanceof HandlerFrame)) continue;
      else if (skip > 0 && entry.key === key) skip--;
      else if (entry.hooks.fork !== false) {
        out.push({ key: entry.key, hooks: entry.hooks, state: entry.state });
      }
    }
    return out;
  }

  // Ends the run in place, closing generators synchronously; there is no machine left
  // to run cleanup that performs effects, so that is skipped. The outermost raise wins.
  reset(): void {
    const abandoned = this.stack.splice(0);
    this.current = undefined!;
    this.value = undefined;
    this.payload = undefined;
    let thrown: { error: unknown } | undefined;
    for (let i = abandoned.length - 1; i >= 0; i--) {
      const entry = abandoned[i];
      if (!(entry instanceof GenFrame)) continue;
      try {
        entry.generator.return(undefined);
      } catch (error) {
        thrown = { error };
      }
    }
    if (thrown !== undefined) throw thrown.error;
  }

  // Cancels every frame above `index`, innermost first, running their cleanup with the
  // stack below them still in place, then goes on with `then`.
  cancelTo(index: number, then: AnyKyoot): AnyKyoot {
    const stack = this.stack;
    while (stack.length > index) {
      const entry = stack.pop()!;
      if (typeof entry === "function" || entry instanceof KyootImpl) continue;
      if (entry.cancel === undefined) continue;
      stack.push(new Unwind(index, then));
      try {
        const cleanup = entry.cancel(this);
        if (cleanup !== undefined) return cleanup;
      } catch (error) {
        then = raise(error);
      }
      stack.pop();
    }
    return then;
  }

  private run(budget: number): Outcome {
    this.remaining = budget;
    while (true) {
      if (!this.spend()) return "yielded";
      try {
        const n = node(this.current);
        switch (n._tag) {
          case "pure": {
            const next = this.deliver(n.a);
            if (next === undefined) return "done";
            this.current = next;
            break;
          }
          case "map":
            this.stack.push(n.b);
            this.current = n.a;
            break;
          case "flatMap":
            this.stack.push(this.current as KyootImpl<unknown>);
            this.current = n.a;
            break;
          case "gen":
            this.current = new GenFrame(n.a()).value(undefined, this);
            break;
          case "op": {
            const next = this.perform(n.a, n.b, n.c);
            if (next === undefined) {
              this.key = n.a;
              this.payload = n.b;
              this.skip = n.c;
              return "suspended";
            }
            this.current = next;
            break;
          }
          case "handler":
            this.stack.push(new HandlerFrame(n.b, n.c));
            this.current = n.a;
            break;
          case "catch":
            this.stack.push(new CatchFrame(n.b));
            this.current = n.a;
            break;
          case "ensure":
            this.stack.push(new EnsureFrame(n.b));
            this.current = n.a;
            break;
          case "resume":
          case "resumeWith": {
            const next = this.resumeAt(this.current);
            if (next === undefined) return "done";
            this.current = next;
            break;
          }
          case "raise":
            throw n.a;
        }
      } catch (error) {
        this.current = this.fail(error);
      }
    }
  }

  // Hands `v` down the stack until a frame has something to run with it.
  private deliver(v: unknown): AnyKyoot | undefined {
    const stack = this.stack;
    while (true) {
      const entry = stack.pop();
      if (entry === undefined) {
        this.value = v;
        return undefined;
      }
      if (typeof entry === "function") {
        v = entry(v);
        continue;
      }
      if (entry instanceof KyootImpl) return (entry.b as (a: unknown) => AnyKyoot)(v);
      if (entry.value === undefined) continue;
      const next = entry.value(v, this);
      if (next !== undefined) return next;
    }
  }

  // Lets the error fall through the stack until a frame takes it. Interruption is not
  // an error to catch: it cancels the whole stack and leaves the machine.
  private fail(error: unknown): AnyKyoot {
    const stack = this.stack;
    if (stack.length === 0) throw error;
    if (error instanceof InterruptedError) return this.cancelTo(0, raise(error));
    while (stack.length > 0) {
      const entry = stack.pop()!;
      if (typeof entry === "function" || entry instanceof KyootImpl) continue;
      if (entry.error === undefined) continue;
      try {
        const next = entry.error(error, this);
        if (next !== undefined) return next;
      } catch (next) {
        error = next;
      }
    }
    throw error;
  }

  // Finds the handler for `key` nearest the top, passing over masked continuations and
  // the first `skip` handlers for the key, and runs its `onOp` above a mask.
  private perform(key: PropertyKey, payload: unknown, skip: number): AnyKyoot | undefined {
    const stack = this.stack;
    const skip0 = skip;
    for (let i = stack.length - 1; i >= 0; i--) {
      const entry = stack[i];
      if (entry instanceof Mask) {
        i = entry.below;
        continue;
      }
      if (!(entry instanceof HandlerFrame) || entry.key !== key) continue;
      if (skip > 0) {
        skip--;
        continue;
      }
      const mask = new Mask(entry, i, stack.length);
      stack.push(mask);
      return entry.hooks.onOp(payload, resumer(mask), entry.state, skip0 + 1);
    }
    return undefined;
  }

  // Resuming ends the handler's program: anything it left above the mask is cancelled,
  // then the op's continuation goes on, with the value or the program it was given.
  private resumeAt(k: AnyKyoot): AnyKyoot | undefined {
    const n = node(k) as { _tag: "resume" | "resumeWith"; a: Mask; b: unknown; c: unknown };
    const mask = n.a;
    const stack = this.stack;
    if (stack[mask.index] !== mask) throw new Error(STALE);
    if (stack.length > mask.index + 1) return this.cancelTo(mask.index + 1, k);
    stack.pop();
    if (n.c !== KEEP) mask.handler.state = n.c;
    return n._tag === "resumeWith" ? (n.b as AnyKyoot) : this.deliver(n.b);
  }
}
