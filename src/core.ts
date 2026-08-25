import {
  NodeSym,
  type AnyKyoot,
  type Continuation,
  type Kyoot,
  type RuntimeNode,
} from "./model.ts";
import { pipeArguments } from "./pipe.ts";
import type { Row } from "./types.ts";

export class KyootImpl<A, S extends Row = {}> implements Kyoot<A, S> {
  readonly [NodeSym]: RuntimeNode;

  constructor(node: RuntimeNode) {
    this[NodeSym] = node;
  }

  // Return `any` so KyootImpl stays assignable to Kyoot under MapResult;
  // callers typed as Kyoot still see the precise MapResult signature.
  map(mapper: (a: any) => any): any {
    return new KyootImpl({ _tag: "map", self: this as AnyKyoot, mapper });
  }

  pipe(...fns: Array<(x: any) => any>) {
    return pipeArguments(this, fns);
  }

  [Symbol.iterator]() {
    let used = false;
    const self = this;
    return {
      next(v: unknown): IteratorResult<Kyoot<unknown, S>, A> {
        if (used) return { done: true, value: v as A };
        used = true;
        return { done: false, value: self };
      },
    };
  }
}

const isKyoot = (value: unknown): value is AnyKyoot => value instanceof KyootImpl;

const makeGenCont = (gen: Generator<AnyKyoot, any, unknown>, input: unknown): AnyKyoot =>
  new KyootImpl({ _tag: "gen-cont", gen, nextInput: input });

export const succeed = <A>(value: A): Kyoot<A, {}> => new KyootImpl({ _tag: "pure", value });

export const makeOp = (key: PropertyKey, payload: unknown) =>
  new KyootImpl({ _tag: "op", effectKey: key, payload });

export class EscapedOp {
  readonly _tag = "EscapedOp";
  readonly key: PropertyKey;
  readonly payload: unknown;
  readonly resume: (v: any) => AnyKyoot;
  readonly resumeError: (err: unknown) => AnyKyoot;
  constructor(
    key: PropertyKey,
    payload: unknown,
    resume: (v: any) => AnyKyoot,
    resumeError: (err: unknown) => AnyKyoot,
  ) {
    this.key = key;
    this.payload = payload;
    this.resume = resume;
    this.resumeError = resumeError;
  }
}

export class InterruptedError extends Error {
  readonly _tag = "InterruptedError";
  constructor(message = "fiber interrupted") {
    super(message);
    this.name = "InterruptedError";
  }
}

const reify = (conts: Array<Continuation>, inner: AnyKyoot): AnyKyoot => {
  for (let i = conts.length - 1; i >= 0; i--) {
    inner = new KyootImpl({ _tag: "map", self: inner, mapper: conts[i]! });
  }
  return inner;
};

export function stepAll(k: AnyKyoot): unknown {
  const continuations: Array<Continuation> = [];
  let current: AnyKyoot = k;

  while (true) {
    const currentNode = current[NodeSym];
    switch (currentNode._tag) {
      case "pure": {
        const f = continuations.pop();
        if (f === undefined) return currentNode.value;
        const out = f(currentNode.value);
        current = isKyoot(out) ? out : succeed(out);
        break;
      }
      case "map": {
        continuations.push(currentNode.mapper);
        current = currentNode.self;
        break;
      }
      case "gen": {
        current = makeGenCont(currentNode.factory(), undefined);
        break;
      }
      case "gen-cont": {
        const step = currentNode.gen.next(currentNode.nextInput);
        if (step.done === true) {
          current = succeed(step.value);
        } else {
          continuations.push((input) => makeGenCont(currentNode.gen, input));
          current = step.value;
        }
        break;
      }
      case "op": {
        const captured = continuations.splice(0);
        let used = false;
        const claim = (): void => {
          if (used) throw new Error("continuation resumed twice (one-shot law)");
          used = true;
        };
        const resume = (v: any) => {
          claim();
          return reify(captured, succeed(v));
        };
        const resumeError = (err: unknown) => {
          claim();
          return reify(captured, new KyootImpl({ _tag: "raise", error: err }));
        };
        throw new EscapedOp(currentNode.effectKey, currentNode.payload, resume, resumeError);
      }
      case "raise": {
        throw currentNode.error;
      }
      case "handler": {
        const handler = currentNode;
        const rewrap = (self: AnyKyoot, state: unknown = handler.state): AnyKyoot =>
          new KyootImpl({ ...handler, self, state });
        let inner: unknown;
        try {
          inner = stepAll(handler.self);
        } catch (e) {
          if (e instanceof InterruptedError) {
            const { onInterrupt } = handler;
            if (onInterrupt !== undefined) {
              try {
                onInterrupt(handler.state);
              } catch {
                /* finalizer errors must not mask interrupt */
              }
            }
            throw e;
          }
          if (e instanceof EscapedOp) {
            if (e.key === handler.effectKey) {
              current = handler.onOp(
                e.payload,
                (v, ...next) => rewrap(e.resume(v), next.length > 0 ? next[0] : handler.state),
                handler.state,
              );
              break;
            }
            const captured = continuations.splice(0);
            throw new EscapedOp(
              e.key,
              e.payload,
              (v) => reify(captured, rewrap(e.resume(v))),
              (err) => reify(captured, rewrap(e.resumeError(err))),
            );
          }
          // Anything that is not one of our two control exceptions is a defect.
          const { onDefect } = handler;
          if (onDefect === undefined) throw e;
          current = onDefect(e, handler.state);
          break;
        }
        current = (handler.onSuccess ?? succeed)(inner, handler.state);
        break;
      }
    }
  }
}
