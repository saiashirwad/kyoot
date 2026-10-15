import { InterruptedError, KEEP, KyootImpl, node, raise, succeed } from "./core.ts";
import type { AnyKyoot, HandlerHooks, RuntimeResume, Snapshot } from "./model.ts";

export type Outcome = "done" | "suspended" | "yielded";

const STALE = "resume used outside the operation it answers";

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
      const { tail, onOp } = entry.hooks;
      if (tail !== undefined) return succeed(tail(payload, entry.state));
      const mask = new Mask(entry, i, stack.length);
      stack.push(mask);
      return onOp!(payload, resumer(mask), entry.state, skip0 + 1);
    }
    return undefined;
  }

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
