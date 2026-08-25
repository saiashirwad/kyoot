import {
  NodeSym,
  type AnyKyoot,
  type Continuation,
  type Kyoot,
  type RowOf,
  type RuntimeNode,
} from "./model.ts";
import { pipeArguments, type Pipeable } from "./pipe.ts";
import type { MergeAll, Row, Simplify } from "./types.ts";

// The interface carries pipe's overloads; the class merges with it.
// oxlint-disable-next-line no-unused-vars, typescript/no-unsafe-declaration-merging
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
    return {
      next: (v: unknown): IteratorResult<Kyoot<unknown, S>, A> => {
        if (used) return { done: true, value: v as A };
        used = true;
        return { done: false, value: this };
      },
    };
  }
}

export const isKyoot = (value: unknown): value is AnyKyoot => value instanceof KyootImpl;

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

// resume's result is opaque: the handler's type comes from `self`, not from
// what resume hands back. Returning `never` keeps it out of inference.
// `resume.with` continues the program with a computation instead of a value,
// run where the op was performed, so the program's own handlers see it.
export interface Resume<A, St> {
  (value: A, state?: St): Kyoot<never, {}>;
  with(program: Kyoot<A, any>, state?: St): Kyoot<never, {}>;
}

type Performed<K extends string, P, A, E> = [E] extends [never]
  ? Kyoot<A, { [k in K]: P }>
  : Kyoot<A, Simplify<{ [k in K]: P } & { fail: E }>>;

// A declared effect: key, payload type, answer type, and the failure type a
// handler may hand back with `resume.with(Fail.fail(e))`. Calling it performs
// the op; `handle` builds a handler whose `resume` is typed to the answer.
// Like makeHandler, a callback that returns instead of resuming adds its
// value and row to the result. `intercept` sits between the program and the
// handlers outside it: `next` performs the op again for them to answer.
export const effect =
  <P, A, E = never>() =>
  <const K extends string>(key: K) => {
    const perform = (payload: P) => makeOp(key, payload) as Performed<K, P, A, E>;
    const handle =
      <St = undefined, X1 = never, X2 = never, R1 extends Row = {}, R2 extends Row = {}>(hooks: {
        initial?: St;
        onOp: (payload: P, resume: Resume<A, St>, state: St) => Kyoot<X1, R1>;
        onDefect?: (d: unknown, state: St) => Kyoot<X2, R2>;
        onInterrupt?: (state: St) => void;
      }) =>
      <B, S extends Row & { [k in K]?: P }>(
        k: Kyoot<B, S>,
      ): Kyoot<B | X1 | X2, MergeAll<Omit<S, K> | R1 | R2>> =>
        makeHandler(key, k, hooks);
    // Whatever `f` does, its outcome is delivered where the op was performed:
    // a value resumes, a failure is raised there for the program to catch.
    const intercept = <Ret extends Kyoot<A, any>>(
      f: (payload: P, next: (payload: P) => Performed<K, P, A, E>) => Ret,
    ) =>
      handle({
        onOp: (payload, resume) =>
          makeHandler("fail", f(payload, perform) as AnyKyoot, {
            onOp: (e) => resume.with(makeOp("fail", e) as AnyKyoot),
            onSuccess: (a) => resume(a),
          }) as Kyoot<never, RowOf<Ret>>,
      });
    return Object.assign(perform, { key, handle, intercept });
  };

// The payload type an effect key carries in the row, if the row has it.
type Payload<S, K extends PropertyKey> = K extends keyof S ? Exclude<S[K], undefined> : never;

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
>(
  effectKey: K,
  self: Kyoot<A, S>,
  hooks: {
    initial?: St;
    onOp: (payload: P, resume: Resume<any, St>, state: St) => Kyoot<B2, R1>;
    onSuccess?: (a: A, state: St) => Kyoot<B, R2>;
    onDefect?: (d: unknown, state: St) => Kyoot<B3, R3>;
    onInterrupt?: (state: St) => void;
  },
): Kyoot<B | B2 | B3, MergeAll<Omit<S, K> | R1 | R2 | R3>> {
  const { initial, ...rest } = hooks;
  return new KyootImpl({
    _tag: "handler",
    effectKey,
    self,
    state: initial,
    ...(rest as any),
  }) as AnyKyoot;
}

export class EscapedOp {
  readonly _tag = "EscapedOp";
  readonly key: PropertyKey;
  readonly payload: unknown;
  readonly resumeWith: (k: AnyKyoot) => AnyKyoot;
  constructor(key: PropertyKey, payload: unknown, resumeWith: (k: AnyKyoot) => AnyKyoot) {
    this.key = key;
    this.payload = payload;
    this.resumeWith = resumeWith;
  }
  resume(v: unknown) {
    return this.resumeWith(succeed(v));
  }
  resumeError(err: unknown) {
    return this.resumeWith(new KyootImpl({ _tag: "raise", error: err }));
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
        throw new EscapedOp(currentNode.effectKey, currentNode.payload, (k) => {
          if (used) throw new Error("continuation resumed twice (one-shot law)");
          used = true;
          return reify(captured, k);
        });
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
            const fin = handler.onInterrupt?.(handler.state);
            if (!isKyoot(fin)) throw e;
            current = fin.map(() => {
              throw e;
            });
            break;
          }
          if (e instanceof EscapedOp) {
            if (e.key === handler.effectKey) {
              const state = (next: unknown[]) => (next.length > 0 ? next[0] : handler.state);
              const resume = Object.assign(
                (v: unknown, ...next: unknown[]) => rewrap(e.resume(v), state(next)),
                { with: (k: AnyKyoot, ...next: unknown[]) => rewrap(e.resumeWith(k), state(next)) },
              );
              try {
                current = handler.onOp(e.payload, resume, handler.state);
              } catch (d) {
                // A throw inside onOp is a defect of this handler's scope.
                if (handler.onDefect === undefined) throw d;
                current = handler.onDefect(d, handler.state);
              }
              break;
            }
            const captured = continuations.splice(0);
            throw new EscapedOp(e.key, e.payload, (k) => reify(captured, rewrap(e.resumeWith(k))));
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
