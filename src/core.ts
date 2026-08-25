import {
  type AnyKyoot,
  type Continuation,
  type Kyoot,
  type RuntimeNode,
} from "./model.ts";
import { pipeArguments } from "./pipe.ts";
import type { Row } from "./types.ts";

const T_PURE = 0;
const T_MAP = 1;
const T_OP = 2;
const T_HANDLER = 3;
const T_RAISE = 4;
const T_GEN = 5;
const T_RESUME = 6;

type HandlerNode = Extract<RuntimeNode, { _tag: "handler" }>;

/**
 * Every node is one object of one shape: `tag` says what `a`/`b` mean.
 *   pure:    a = value
 *   map:     a = self, b = mapper
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

  pipe(...fns: Array<(x: any) => any>) {
    return pipeArguments(this, fns);
  }

  [Symbol.iterator]() {
    return new SingleShot<A, S>(this);
  }
}

class SingleShot<A, S extends Row> implements Iterator<Kyoot<unknown, S>, A, unknown> {
  private used = false;
  private readonly self: Kyoot<unknown, S>;
  constructor(self: Kyoot<unknown, S>) {
    this.self = self;
  }
  next(v: unknown): IteratorResult<Kyoot<unknown, S>, A> {
    if (this.used) return { done: true, value: v as A };
    this.used = true;
    return { done: false, value: this.self };
  }
}

const isKyoot = (value: unknown): value is AnyKyoot => value instanceof KyootImpl;

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
  readonly gen = null;
  readonly h: HandlerNode;
  state: unknown;
  constructor(h: HandlerNode) {
    this.h = h;
    this.state = h.state;
  }
}

/** A running generator on the interpreter stack. */
class GenFrame {
  readonly gen: Generator<AnyKyoot, unknown, unknown>;
  constructor(gen: Generator<AnyKyoot, unknown, unknown>) {
    this.gen = gen;
  }
}

/** A slice of stack (frames + continuations) plus the value to feed it. */
class ResumeNode {
  captured: Array<Entry> | null;
  readonly value: unknown;
  readonly frame: Frame;
  readonly state: unknown;
  constructor(captured: Array<Entry> | null, value: unknown, frame: Frame, state: unknown) {
    this.captured = captured;
    this.value = value;
    this.frame = frame;
    this.state = state;
  }
}

type Entry = Continuation | Frame | GenFrame;

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
      if (typeof top === "function" || top.gen !== null) continue;
      if (interrupted) {
        const { onInterrupt } = top.h;
        if (onInterrupt !== undefined) {
          try {
            onInterrupt(top.state);
          } catch {
            /* finalizer errors must not mask interrupt */
          }
        }
        continue;
      }
      const { onDefect } = top.h;
      if (onDefect !== undefined) return onDefect(e, top.state);
    }
    throw e;
  }

  private drive(current: AnyKyoot): void {
    const stack = this.stack;
    while (true) {
      const node = current as unknown as KyootImpl<any, any>;
      switch (node.tag) {
        case T_PURE: {
          let value: unknown = node.a;
          // Deliver the value down the stack until something produces a node.
          while (true) {
            const top = stack.pop();
            if (top === undefined) {
              this.status = Status.Done;
              this.value = value;
              return;
            }
            let out: unknown;
            if (typeof top === "function") {
              out = top(value);
            } else if (top.gen !== null) {
              const s = top.gen.next(value);
              if (s.done) {
                value = s.value;
                continue;
              }
              stack.push(top);
              current = s.value;
              break;
            } else {
              const { onSuccess } = top.h;
              if (onSuccess === undefined) continue;
              out = onSuccess(value, top.state);
            }
            if (isKyoot(out)) {
              current = out;
              break;
            }
            value = out;
          }
          break;
        }
        case T_MAP: {
          stack.push(node.b);
          current = node.a;
          break;
        }
        case T_HANDLER: {
          const h = node.a as HandlerNode;
          stack.push(new Frame(h));
          current = h.self;
          break;
        }
        case T_OP: {
          const key = node.a as PropertyKey;
          let h = stack.length - 1;
          for (; h >= 0; h--) {
            const f = stack[h]!;
            if (typeof f !== "function" && f.gen === null && f.h.effectKey === key) break;
          }
          if (h < 0) {
            this.status = Status.Suspended;
            this.key = key;
            this.payload = node.b;
            return;
          }
          const frame = stack[h] as Frame;
          let token: ResumeNode | undefined;
          let captured: Array<Entry> | null = null;
          const resume = (v: unknown, ...next: Array<unknown>) => {
            if (token !== undefined) throw new Error("continuation resumed twice (one-shot law)");
            token = new ResumeNode(captured, v, frame, next.length > 0 ? next[0] : frame.state);
            return new KyootImpl(T_RESUME, token);
          };
          let out: AnyKyoot;
          try {
            out = frame.h.onOp(node.b, resume, frame.state);
          } catch (e) {
            stack.length = h;
            throw e;
          }
          if (token !== undefined && (out as unknown as KyootImpl<any, any>).a === token) {
            // Fast path: handler resumed in place. Stack is untouched.
            frame.state = token.state;
            current = succeed(token.value) as AnyKyoot;
            break;
          }
          // Slow path: the rest of the inner computation leaves the stack.
          captured = stack.splice(h);
          if (token !== undefined) {
            token.captured = captured;
          }
          current = out;
          break;
        }
        case T_GEN: {
          stack.push(new GenFrame(node.a()));
          current = succeed(undefined) as AnyKyoot;
          break;
        }
        case T_RESUME: {
          const r = node.a as ResumeNode;
          const captured = r.captured!;
          r.frame.state = r.state;
          for (let i = 0; i < captured.length; i++) stack.push(captured[i]!);
          current = succeed(r.value) as AnyKyoot;
          break;
        }
        case T_RAISE: {
          throw node.a;
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
