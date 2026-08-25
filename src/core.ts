import {
  NodeSym,
  type AnyKyoot,
  type Continuation,
  type Kyoot,
  type RuntimeNode,
} from "./model.ts";
import { pipeArguments, type Pipeable } from "./pipe.ts";
import type { MergeAll, Row } from "./types.ts";

export interface KyootImpl<A, S extends Row = {}> extends Pipeable {}
export class KyootImpl<A, S extends Row = {}> implements Kyoot<A, S> {
  readonly [NodeSym]: RuntimeNode;

  constructor(node: RuntimeNode) {
    this[NodeSym] = node;
  }

  // Parameter typed by A so a KyootImpl never infers A as `any` downstream;
  // return stays `any` so KyootImpl is assignable to Kyoot under MapResult.
  map(mapper: (a: A) => any): any {
    return new KyootImpl({ _tag: "map", self: this as AnyKyoot, mapper });
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

export const succeed = <A>(value: A): Kyoot<A, {}> => new KyootImpl({ _tag: "pure", value });

export const makeOp = (key: PropertyKey, payload: unknown) =>
  new KyootImpl({ _tag: "op", effectKey: key, payload });

// Typed op constructor. The row records the key and the payload type, so a
// handler's `onOp` can read the payload type back off the row. `A` is what
// the op resumes with; TS can't infer it, hence the two-step call.
export const op =
  <A>() =>
  <const K extends string, P>(key: K, payload: P): Kyoot<A, { [k in K]: P }> =>
    makeOp(key, payload) as Kyoot<A, { [k in K]: P }>;

export interface Hooks<P, A, St, R extends Row> {
  readonly state?: St;
  readonly onOp: (
    payload: P,
    resume: (a: A, state?: St) => Kyoot<never, {}>,
    state: St,
  ) => Kyoot<any, R>;
  readonly onDefect?: (d: unknown, state: St) => Kyoot<any, R>;
  readonly onInterrupt?: (state: St) => void;
}

// A declared effect: key, payload type, answer type. Calling it performs the
// op; `handle` builds a handler whose `resume` is typed to the answer.
export const effect =
  <P, A>() =>
  <const K extends string>(key: K) => {
    const perform = (payload: P) => op<A>()(key, payload);
    const handle =
      <St = undefined, R extends Row = {}>(hooks: Hooks<P, A, St, R>) =>
      <B, S extends Row & { [k in K]?: P }>(k: Kyoot<B, S>): Kyoot<B, MergeAll<Omit<S, K> | R>> =>
        makeHandler({ effectKey: key, self: k, ...hooks });
    return Object.assign(perform, { key, handle });
  };

// The payload type an effect key carries in the row, if the row has it.
type Payload<S, K extends PropertyKey> = K extends keyof S ? Exclude<S[K], undefined> : never;

// resume\x27s result is opaque: the handler\x27s type comes from `self`, not from
// what resume hands back. Returning `never` keeps it out of inference.
export type Resume<St> = (value: any, state?: St) => Kyoot<never, {}>;

// Build a handler node and infer its type: the result is what onSuccess
// returns (default: the inner value) plus anything onOp / onDefect
// short-circuit with; the row is the inner row minus K plus whatever the
// callbacks introduce.
export function makeHandler<
  K extends PropertyKey,
  A,
  S extends Row,
  St = undefined,
  // Ops built with `op` put their payload type in the row, so this default is
  // right for them. Env and Var record something else (the service / state
  // type) and annotate the payload themselves.
  P = Payload<S, K>,
  B = A,
  B2 = never,
  B3 = never,
  R1 extends Row = {},
  R2 extends Row = {},
  R3 extends Row = {},
>(node: {
  effectKey: K;
  self: Kyoot<A, S>;
  state?: St;
  onOp: (payload: P, resume: Resume<St>, state: St) => Kyoot<B2, R1>;
  onSuccess?: (a: A, state: St) => Kyoot<B, R2>;
  onDefect?: (d: unknown, state: St) => Kyoot<B3, R3>;
  onInterrupt?: (state: St) => void;
}): Kyoot<B | B2 | B3, MergeAll<Omit<S, K> | R1 | R2 | R3>> {
  return new KyootImpl({ _tag: "handler", ...(node as any) }) as AnyKyoot;
}

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

KyootImpl.prototype.pipe = function (this: unknown, ...fns: Array<(x: any) => any>) {
  return pipeArguments(this, fns);
};
