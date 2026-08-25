import {
  type AnyKyoot,
  type Kyoot,
  type RuntimeNode,
} from "./model.ts";
import { pipeArguments } from "./pipe.ts";
import type { Row } from "./types.ts";
import type { Resume } from "./model.ts";

const T_PURE = 0;
const T_MAP = 1;
const T_OP = 2;
const T_HANDLER = 3;
const T_RAISE = 4;
const T_GEN = 5;
const T_RESUME = 6;
const T_FLATMAP = 7;
// Stack-only entries.
const T_FRAME = 8;
const T_GENFRAME = 9;

type HandlerNode = Extract<RuntimeNode, { _tag: "handler" }>;

/**
 * Every node is one object of one shape: `tag` says what `a`/`b` mean.
 *   pure:    a = value
 *   map:     a = self, b = mapper (returns a value)
 *   flatMap: a = self, b = mapper (returns a Kyoot)
 *   op:      a = effectKey, b = payload
 *   handler: a = handler literal
 *   raise:   a = error
 *   gen:     a = generator factory
 *   resume:  a = ResumeNode
 */
export class KyootImpl<A, S extends Row = {}> implements Kyoot<A, S> {
  readonly tag: number;
  readonly a: any;
  readonly b: any;

  constructor(tag: number | RuntimeNode, a?: unknown, b?: unknown) {
    if (typeof tag === "object") {
      // Literal form, kept for handler authors and tests.
      const node = tag;
      switch (node._tag) {
        case "pure":
          this.tag = T_PURE; this.a = node.value; this.b = undefined; break;
        case "map":
          this.tag = T_MAP; this.a = node.self; this.b = node.mapper; break;
        case "op":
          this.tag = T_OP; this.a = node.effectKey; this.b = node.payload; break;
        case "handler":
          this.tag = T_HANDLER; this.a = node; this.b = undefined; break;
        case "raise":
          this.tag = T_RAISE; this.a = node.error; this.b = undefined; break;
      }
    } else {
      this.tag = tag; this.a = a; this.b = b;
    }
  }

  map(mapper: (a: any) => any): any {
    return new KyootImpl(T_MAP, this, mapper);
  }

  flatMap(mapper: (a: any) => AnyKyoot): any {
    return new KyootImpl(T_FLATMAP, this, mapper);
  }

  pipe(...fns: Array<(x: any) => any>) {
    return pipeArguments(this, fns);
  }

  [Symbol.iterator]() {
    return new SingleShot<A, S>(this);
  }
}

// `yield*` reads `done`/`value` right after each `next`, so one result
// object per iterator is safe to mutate in place.
class SingleShot<A, S extends Row> implements Iterator<Kyoot<unknown, S>, A, unknown> {
  private used = false;
  private readonly r: { done: boolean; value: any };
  constructor(self: Kyoot<unknown, S>) {
    this.r = { done: false, value: self };
  }
  next(v: unknown): IteratorResult<Kyoot<unknown, S>, A> {
    const r = this.r;
    if (this.used) {
      r.done = true;
      r.value = v;
    } else {
      this.used = true;
    }
    return r as IteratorResult<Kyoot<unknown, S>, A>;
  }
}

export const succeed = <A>(value: A): Kyoot<A, {}> => new KyootImpl(T_PURE, value);

export const makeOp = (key: PropertyKey, payload: unknown): AnyKyoot =>
  new KyootImpl(T_OP, key, payload);

export const genNode = (f: () => Generator<AnyKyoot, unknown, unknown>): AnyKyoot =>
  new KyootImpl(T_GEN, f);

export class InterruptedError extends Error {
  readonly _tag = "InterruptedError";
  constructor(message = "fiber interrupted") {
    super(message);
    this.name = "InterruptedError";
  }
}

/** Thrown by `runSync` style edges when an op reaches the bottom of the stack. */
export class EscapedOp {
  readonly _tag = "EscapedOp";
  readonly key: PropertyKey;
  readonly payload: unknown;
  constructor(key: PropertyKey, payload: unknown) {
    this.key = key;
    this.payload = payload;
  }
}

/** A handler's activation on the interpreter stack. */
class Frame {
  readonly tag = T_FRAME;
  readonly h: HandlerNode;
  state: unknown;
  // Per-op scratch: set by `resume`, read by the interpreter.
  armed = false;
  resumed = false;
  value: unknown = undefined;
  next: unknown = undefined;
  /** Stack segment owned by an op that left the stack without resuming. */
  captured: Array<Entry> | null = null;
  readonly token: KyootImpl<any, any>;
  readonly resume: Resume;
  constructor(h: HandlerNode) {
    this.h = h;
    this.state = h.state;
    this.token = new KyootImpl(T_RESUME, this);
    const self = this;
    this.resume = function (v: unknown, next?: unknown) {
      if (self.armed) {
        // Inside onOp: record and hand back the frame's token.
        if (self.resumed) throw new Error("continuation resumed twice (one-shot law)");
        self.resumed = true;
        self.value = v;
        self.next = arguments.length > 1 ? next : self.state;
        return self.token;
      }
      // After onOp returned without resuming: rebuild from the captured segment.
      const captured = self.captured;
      if (captured === null) throw new Error("continuation resumed twice (one-shot law)");
      self.captured = null;
      return new KyootImpl(
        T_RESUME,
        new ResumeNode(captured, v, self, arguments.length > 1 ? next : self.state),
      );
    };
  }
}

/** A running generator on the interpreter stack. */
class GenFrame {
  readonly tag = T_GENFRAME;
  readonly gen: Generator<AnyKyoot, unknown, unknown>;
  constructor(gen: Generator<AnyKyoot, unknown, unknown>) {
    this.gen = gen;
  }
}

/** A slice of stack (frames + continuations) plus the value to feed it. */
class ResumeNode {
  readonly captured: Array<Entry>;
  readonly value: unknown;
  readonly frame: Frame;
  readonly state: unknown;
  constructor(captured: Array<Entry>, value: unknown, frame: Frame, state: unknown) {
    this.captured = captured;
    this.value = value;
    this.frame = frame;
    this.state = state;
  }
}

/** Stack entries: map functions, flatMap nodes, handler frames, generator frames. */
type Entry = ((v: any) => any) | KyootImpl<any, any> | Frame | GenFrame;

export type Status = 0 | 1 | 2;
export const Status = { Done: 0 as const, Suspended: 1 as const, Running: 2 as const };

/**
 * One interpreter loop with one stack. `run` returns when the program
 * finishes or an op reaches the bottom of the stack (suspension). Call
 * `resume`/`resumeError` to continue after a suspension on the same stack.
 */
export class Interp {
  private readonly stack: Array<Entry> = [];
  status: Status = Status.Done;
  value: unknown = undefined;
  key: PropertyKey = "";
  payload: unknown = undefined;

  run(k: AnyKyoot): void {
    this.loop(k);
  }

  resume(v: unknown): void {
    this.loop(succeed(v) as AnyKyoot);
  }

  resumeError(e: unknown): void {
    this.loop(new KyootImpl(T_RAISE, e) as AnyKyoot);
  }

  private loop(current: AnyKyoot): void {
    this.status = Status.Running;
    while (true) {
      try {
        this.drive(current);
        return;
      } catch (e) {
        current = this.unwind(e);
      }
    }
  }

  /** Pops frames until one takes the error, returns what to run next; rethrows at the bottom. */
  private unwind(e: unknown): AnyKyoot {
    const stack = this.stack;
    const interrupted = e instanceof InterruptedError;
    while (stack.length > 0) {
      const top = stack.pop()!;
      if (typeof top === "function" || top.tag !== T_FRAME) continue;
      const frame = top as Frame;
      if (interrupted) {
        const { onInterrupt } = frame.h;
        if (onInterrupt !== undefined) {
          try {
            onInterrupt(frame.state);
          } catch {
            /* finalizer errors must not mask interrupt */
          }
        }
        continue;
      }
      const { onDefect } = frame.h;
      if (onDefect !== undefined) return onDefect(e, frame.state);
    }
    throw e;
  }

  private drive(current: AnyKyoot): void {
    const stack = this.stack;
    let value: unknown = undefined;
    while (true) {
      const node = current as unknown as KyootImpl<any, any>;
      switch (node.tag) {
        case T_PURE: {
          value = node.a;
          break;
        }
        case T_MAP: {
          stack.push(node.b);
          current = node.a;
          continue;
        }
        case T_FLATMAP: {
          stack.push(node);
          current = node.a;
          continue;
        }
        case T_HANDLER: {
          const h = node.a as HandlerNode;
          stack.push(new Frame(h));
          current = h.self;
          continue;
        }
        case T_OP: {
          const key = node.a as PropertyKey;
          let h = stack.length - 1;
          for (; h >= 0; h--) {
            const f = stack[h]!;
            if (typeof f !== "function" && f.tag === T_FRAME && (f as Frame).h.effectKey === key) break;
          }
          if (h < 0) {
            this.status = Status.Suspended;
            this.key = key;
            this.payload = node.b;
            return;
          }
          const frame = stack[h] as Frame;
          frame.armed = true;
          frame.resumed = false;
          let out: AnyKyoot;
          try {
            out = frame.h.onOp(node.b, frame.resume, frame.state);
          } catch (e) {
            frame.armed = false;
            stack.length = h;
            throw e;
          }
          frame.armed = false;
          if (out === frame.token) {
            // Fast path: handler resumed in place. Stack untouched, nothing allocated.
            frame.state = frame.next;
            value = frame.value;
            break;
          }
          // Slow path: the rest of the inner computation leaves the stack.
          const captured = stack.splice(h);
          if (frame.resumed) {
            // resume(v) was called but wrapped, e.g. resume(v).map(f): materialize it.
            (frame.token as { a: unknown }).a = new ResumeNode(
              captured,
              frame.value,
              frame,
              frame.next,
            );
          } else {
            frame.captured = captured;
          }
          current = out;
          continue;
        }
        case T_GEN: {
          stack.push(new GenFrame(node.a()));
          value = undefined;
          break;
        }
        case T_RESUME: {
          let r: ResumeNode;
          if (node.a instanceof Frame) {
            // The frame's own token, used as a value: take the materialized node out of it.
            const f = node.a;
            const m = f.token.a as ResumeNode | Frame;
            if (m === f) throw new Error("continuation resumed twice (one-shot law)");
            (f.token as { a: unknown }).a = f;
            r = m as ResumeNode;
          } else {
            r = node.a as ResumeNode;
          }
          const captured = r.captured;
          r.frame.state = r.state;
          for (let i = 0; i < captured.length; i++) stack.push(captured[i]!);
          value = r.value;
          break;
        }
        case T_RAISE: {
          throw node.a;
        }
      }
      // Deliver the value down the stack until something produces a node.
      while (true) {
        const top = stack.pop();
        if (top === undefined) {
          this.status = Status.Done;
          this.value = value;
          return;
        }
        if (typeof top === "function") {
          value = top(value);
        } else if (top.tag === T_FLATMAP) {
          current = (top as KyootImpl<any, any>).b(value);
          break;
        } else if (top.tag === T_GENFRAME) {
          const s = (top as GenFrame).gen.next(value);
          if (s.done) {
            value = s.value;
            continue;
          }
          stack.push(top);
          current = s.value;
          break;
        } else {
          const { onSuccess } = (top as Frame).h;
          if (onSuccess === undefined) continue;
          current = onSuccess(value, (top as Frame).state);
          break;
        }
      }
    }
  }
}

export function stepAll(k: AnyKyoot): unknown {
  const it = new Interp();
  it.run(k);
  if (it.status === Status.Suspended) throw new EscapedOp(it.key, it.payload);
  return it.value;
}
