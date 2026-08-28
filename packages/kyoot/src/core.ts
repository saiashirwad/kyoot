import {
  NodeSym,
  type AnyKyoot,
  type ForkMode,
  type HandlerNode,
  type Kyoot,
  type OnOp,
  type RowOf,
  type RuntimeNode,
} from "./model.ts";
import { pipeArguments, type Pipeable } from "./pipe.ts";
import type { FailRow, MergeAll, Row, Simplify } from "./types.ts";

// One `yield*` on a program: hand the program out, then hand the answer
// back. `yield*` reads each result before it calls `next` again, so one
// result object serves both.
class KyootIterator<A, S extends Row> implements Iterator<Kyoot<unknown, S>, A, unknown> {
  private used = false;
  private readonly result: { done: boolean; value: unknown };
  constructor(k: Kyoot<unknown, S>) {
    this.result = { done: false, value: k };
  }
  next(v?: unknown): IteratorResult<Kyoot<unknown, S>, A> {
    if (this.used) {
      this.result.done = true;
      this.result.value = v;
    } else {
      this.used = true;
    }
    return this.result as IteratorResult<Kyoot<unknown, S>, A>;
  }
}

// The interface carries pipe's overloads; the class merges with it.
// oxlint-disable-next-line no-unused-vars, typescript/no-unsafe-declaration-merging
export interface KyootImpl<A, S extends Row = {}> extends Pipeable {}
export class KyootImpl<A, S extends Row = {}> implements Kyoot<A, S> {
  readonly [NodeSym]: RuntimeNode;

  constructor(node: RuntimeNode) {
    this[NodeSym] = node;
  }

  // Parameter typed by A so a KyootImpl never infers A as `any` downstream;
  // return types stay `any` so the class does not repeat Kyoot's row math.
  map(mapper: (a: A) => any): any {
    return new KyootImpl({ _tag: "map", self: this as AnyKyoot, mapper });
  }

  flatMap(mapper: (a: A) => AnyKyoot): any {
    return new KyootImpl({ _tag: "flatMap", self: this as AnyKyoot, mapper });
  }

  [Symbol.iterator]() {
    return new KyootIterator<A, S>(this);
  }
}

export const isKyoot = (value: unknown): value is AnyKyoot => value instanceof KyootImpl;

export const succeed = <A>(value: A): Kyoot<A, {}> => new KyootImpl({ _tag: "pure", value });

// An op built with a `handlers` list collects the frames it crosses on its
// way out (see Machine), so a fiber it spawns can inherit them. `async` is
// one; an interceptor's `next` passes on what the op had crossed.
export const makeOp = (key: PropertyKey, payload: unknown, handlers?: readonly HandlerNode[]) =>
  new KyootImpl({ _tag: "op", effectKey: key, payload, handlers });

export const genNode = (factory: () => Generator<AnyKyoot, unknown, unknown>): AnyKyoot =>
  new KyootImpl({ _tag: "gen", factory });

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

type Performed<K extends string, V, A, E> = Kyoot<A, Simplify<{ [k in K]: V } & FailRow<E>>>;

// A cell for `intercept`: `create` runs when the frame is entered, so each
// run gets its own; `fork` says what a fiber gets (see Hooks).
export interface Cell<St> {
  readonly create: () => St;
  readonly fork?: ForkMode;
}

type Interceptor<K extends string, P, V, A, E, St, Ret> = (
  payload: P,
  next: (payload: P) => Performed<K, V, A, E>,
  state: St,
) => Ret;

// An interceptor removes K from the row and adds whatever `f` performs.
type Interception<K extends string, V, Ret> = <B, S extends Row & { [k in K]?: V }>(
  k: Kyoot<B, S>,
) => Kyoot<B, MergeAll<Omit<S, K> | RowOf<Ret>>>;

export interface Intercept<K extends string, P, A, E = never, V = P> {
  <Ret extends Kyoot<A, any>>(
    f: Interceptor<K, P, V, A, E, undefined, Ret>,
  ): Interception<K, V, Ret>;
  <St, Ret extends Kyoot<A, any>>(
    cell: Cell<St>,
    f: Interceptor<K, P, V, A, E, St, Ret>,
  ): Interception<K, V, Ret>;
}

// Build `intercept` for a key. `P` is the payload `f` sees and `next` takes;
// `V` is what the row records for the key: the payload, unless the module
// records something else, as Env and Var do. Whatever `f` does, its outcome
// is delivered where the op was performed: a value resumes, a failure is
// raised there for the program to catch. `fail` is special: the op site is
// the failure itself, so `f`'s program is the answer and runs outside the
// frame. `next` re-performs the op with the frames it had crossed, so a
// fiber forked through an interceptor inherits them, and the interceptor.
export const makeIntercept = <K extends string, P, A, E = never, V = P>(
  key: K,
): Intercept<K, P, A, E, V> => {
  type F = Interceptor<K, P, V, A, E, any, AnyKyoot>;
  const deliver =
    key === "fail"
      ? (k: AnyKyoot) => k
      : (k: AnyKyoot, resume: Parameters<OnOp>[1]): AnyKyoot =>
          makeHandler("fail", k, {
            onOp: (e) => resume.with(makeOp("fail", e) as AnyKyoot),
            onSuccess: (a) => resume(a),
          });
  return (cellOrF: Cell<unknown> | F, maybeF?: F) => {
    const cell = typeof cellOrF === "function" ? undefined : cellOrF;
    const f = typeof cellOrF === "function" ? cellOrF : maybeF!;
    const onOp: OnOp = (payload, resume, state, inherited) =>
      deliver(
        f(payload, (p) => makeOp(key, p, inherited) as never, state),
        resume,
      );
    return (k: AnyKyoot) =>
      makeHandler(key, k, { create: cell?.create, fork: cell?.fork, onOp: onOp as never });
  };
};

// What a handler is made of. State is `initial`, threaded through `resume`,
// or `create()`, called when the frame is entered: a cell that is fresh per
// run and shared with fibers forked under the handler.
export interface Hooks<P, A, St, X1, R1 extends Row, X2, R2 extends Row, R3 extends Row> {
  initial?: St;
  create?: () => St;
  fork?: ForkMode;
  onOp: (payload: P, resume: Resume<A, St>, state: St) => Kyoot<X1, R1>;
  onDefect?: (d: unknown, state: St) => Kyoot<X2, R2>;
  onInterrupt?: (state: St) => void | Kyoot<unknown, R3>;
}

// A declared effect: key, payload type, answer type, and the failure type a
// handler may hand back with `resume.with(Fail.fail(e))`. `V` is what the
// row records for the key: the payload, unless the module records something
// else, as Env and Var do. Calling it performs the op; `handle` builds a
// handler whose `resume` is typed to the answer. Like makeHandler, a
// callback that returns instead of resuming adds its value and row to the
// result. `intercept` sits between the program and the handlers outside it:
// `next` performs the op again for them to answer.
export const effect =
  <P, A, E = never, V = P>() =>
  <const K extends string>(key: K) => {
    const perform = (payload: P) => makeOp(key, payload) as Performed<K, V, A, E>;
    const handle =
      <
        St = undefined,
        X1 = never,
        X2 = never,
        R1 extends Row = {},
        R2 extends Row = {},
        R3 extends Row = {},
      >(
        hooks: Hooks<P, A, St, X1, R1, X2, R2, R3>,
      ) =>
      <B, S extends Row & { [k in K]?: V }>(
        k: Kyoot<B, S>,
      ): Kyoot<B | X1 | X2, MergeAll<Omit<S, K> | R1 | R2 | R3>> =>
        makeHandler(key, k, hooks);
    // `intercept({ create }, f)` hands `f` a cell as its third argument: made
    // fresh per run, shared with fibers forked under it. A cache is one.
    const intercept = makeIntercept<K, P, A, E, V>(key);
    return Object.assign(perform, { key, handle, intercept });
  };

// The payload type an effect key carries in the row, if the row has it.
export type Payload<S, K extends PropertyKey> = K extends keyof S
  ? Exclude<S[K], undefined>
  : never;

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
  // right for them. Var records the state type and annotates the payload.
  P = Payload<S, K>,
  B = A,
  B2 = never,
  B3 = never,
  R1 extends Row = {},
  R2 extends Row = {},
  R3 extends Row = {},
  R4 extends Row = {},
>(
  effectKey: K,
  self: Kyoot<A, S>,
  hooks: Hooks<P, any, St, B2, R1, B3, R3, R4> & {
    onSuccess?: (a: A, state: St) => Kyoot<B, R2>;
  },
): Kyoot<B | B2 | B3, MergeAll<Omit<S, K> | R1 | R2 | R3 | R4>> {
  const { initial, create, fork, onOp, onSuccess, onDefect, onInterrupt } = hooks;
  // One fixed shape for every handler node. A frame with a cell to make is
  // entered on its first step; the rest start entered, state in hand.
  return new KyootImpl({
    _tag: "handler",
    effectKey,
    self,
    state: initial,
    entered: create === undefined,
    create: create ?? (initial === undefined ? undefined : () => initial),
    fork,
    onOp: onOp as OnOp,
    onSuccess,
    onDefect,
    onInterrupt,
  }) as AnyKyoot;
}

export class InterruptedError extends Error {
  readonly _tag = "InterruptedError";
  constructor(message = "fiber interrupted") {
    super(message);
    this.name = "InterruptedError";
  }
}

// Wrap a fiber's program in the handlers that enclosed the fork.
export const inherit = (k: AnyKyoot, handlers: readonly HandlerNode[] = []): AnyKyoot => {
  for (const h of handlers) {
    switch (h.fork ?? "copy") {
      case "copy":
        k = new KyootImpl({
          ...h,
          self: k,
          onSuccess: undefined,
          onDefect: undefined,
          onInterrupt: undefined,
        });
        break;
      case "scope": {
        // The end hook runs, but the fiber's value stays its own.
        const { onSuccess } = h;
        k = new KyootImpl({
          ...h,
          self: k,
          state: undefined,
          entered: false,
          onSuccess: onSuccess && ((a, st) => onSuccess(a, st).map(() => a)),
        });
        break;
      }
      case "none":
        break;
    }
  }
  return k;
};

KyootImpl.prototype.pipe = function (this: unknown, ...fns: Array<(x: any) => any>) {
  return pipeArguments(this, fns);
};
