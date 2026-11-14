import { KyootImpl, node, raise, succeed, unit } from "./core.ts";
import type { AnyKyoot, OnOp, RuntimeResume } from "./model.ts";

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

// Handlers and masks are pushed once and never re-pushed, so `stack[f.index] === f` says whether f is live.
// Everything a live frame's `prev` reaches is live too: popping it would have popped f first.
class HandlerFrame implements Frame {
  readonly value?: undefined;
  readonly key: PropertyKey;
  readonly onOp: OnOp;
  readonly index: number;
  readonly prev: HandlerFrame | undefined;

  constructor(key: PropertyKey, onOp: OnOp, index: number, prev: HandlerFrame | undefined) {
    this.key = key;
    this.onOp = onOp;
    this.index = index;
    this.prev = prev;
  }
}

class Mask implements Frame {
  readonly handler: HandlerFrame;
  readonly index: number;
  readonly prev: Mask | undefined;

  constructor(handler: HandlerFrame, index: number, prev: Mask | undefined) {
    this.handler = handler;
    this.index = index;
    this.prev = prev;
  }

  value(answer: unknown, m: Machine): AnyKyoot {
    return m.cancelTo(this.handler.index, succeed(answer));
  }

  error(e: unknown, m: Machine): AnyKyoot {
    return m.cancelTo(this.handler.index, raise(e));
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
  const resume = (value: unknown): AnyKyoot => new KyootImpl("resume", mask, value);
  resume.with = (program: AnyKyoot): AnyKyoot => new KyootImpl("resumeWith", mask, program);
  return resume;
};

export class Machine {
  private readonly stack: Entry[] = [];
  private handlers: Map<PropertyKey, HandlerFrame> | undefined;
  private mask: Mask | undefined;
  private current!: AnyKyoot;
  private remaining = Infinity;

  value: unknown;
  key: PropertyKey = "";
  payload: unknown;

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

  cancel(budget = Infinity): Outcome {
    this.current = this.cancelTo(0, unit);
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
              return "suspended";
            }
            this.current = next;
            break;
          }
          case "handler": {
            const frame = new HandlerFrame(n.b, n.c, this.stack.length, this.top(n.b));
            (this.handlers ??= new Map()).set(n.b, frame);
            this.stack.push(frame);
            this.current = n.a;
            break;
          }
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
        // Dropping the backing store keeps V8 from pretenuring it: 25% on a 100-map runSync.
        stack.length = 0;
        this.handlers = undefined;
        this.mask = undefined;
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

  private top(key: PropertyKey): HandlerFrame | undefined {
    const handlers = this.handlers;
    if (handlers === undefined) return undefined;
    const stack = this.stack;
    const first = handlers.get(key);
    let h = first;
    while (h !== undefined && stack[h.index] !== h) h = h.prev;
    if (h !== first) {
      if (h === undefined) handlers.delete(key);
      else handlers.set(key, h);
    }
    return h;
  }

  // Masks nest or are disjoint, and a mask hides [handler.index, index]. Walking handlers and masks
  // downward together, a mask whose handler sits above the handler can't hide anything lower.
  private perform(key: PropertyKey, payload: unknown, skip: number): AnyKyoot | undefined {
    const stack = this.stack;
    const past = skip;
    let m = this.mask;
    while (m !== undefined && stack[m.index] !== m) m = m.prev;
    this.mask = m;
    for (let h = this.top(key); h !== undefined; h = h.prev) {
      while (m !== undefined && m.handler.index > h.index) m = m.prev;
      if (m !== undefined && h.index < m.index) continue;
      if (skip > 0) {
        skip--;
        continue;
      }
      const mask = new Mask(h, stack.length, this.mask);
      this.mask = mask;
      stack.push(mask);
      return h.onOp(payload, resumer(mask), past + 1);
    }
    return undefined;
  }

  private resumeAt(k: AnyKyoot): AnyKyoot | undefined {
    const n = node(k) as { _tag: "resume" | "resumeWith"; a: Mask; b: unknown };
    const mask = n.a;
    const stack = this.stack;
    if (stack[mask.index] !== mask) throw new Error(STALE);
    if (stack.length > mask.index + 1) return this.cancelTo(mask.index + 1, k);
    stack.pop();
    return n._tag === "resumeWith" ? (n.b as AnyKyoot) : this.deliver(n.b);
  }
}
