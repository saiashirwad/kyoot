import {
  NodeSym,
  type AnyKyoot,
  type Continuation,
  type ForkMode,
  type HandlerNode,
  type Kyoot,
  type OnOp,
  type RowOf,
  type RuntimeNode,
} from "./model.ts";
import { pipeArguments, type Pipeable } from "./pipe.ts";
import type { FailRow, MergeAll, Row, Simplify } from "./types.ts";

// One `yield*` on a program: hand the program out, then hand the answer back.
class KyootIterator<A, S extends Row> implements Iterator<Kyoot<unknown, S>, A, unknown> {
  private readonly k: Kyoot<unknown, S>;
  private used = false;
  constructor(k: Kyoot<unknown, S>) {
    this.k = k;
  }
  next(v?: unknown): IteratorResult<Kyoot<unknown, S>, A> {
    if (this.used) return { done: true, value: v as A };
    this.used = true;
    return { done: false, value: this.k };
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
  // return stays `any` so KyootImpl is assignable to Kyoot under MapResult.
  map(mapper: (a: A) => any): any {
    return new KyootImpl({ _tag: "map", self: this as AnyKyoot, mapper });
  }

  [Symbol.iterator]() {
    return new KyootIterator<A, S>(this);
  }
}

export const isKyoot = (value: unknown): value is AnyKyoot => value instanceof KyootImpl;

export const succeed = <A>(value: A): Kyoot<A, {}> => new KyootImpl({ _tag: "pure", value });

// An op built with a `handlers` list collects the frames it crosses on its
// way out (see EscapedOp), so a fiber it spawns can inherit them. `async` is
// one; an interceptor's `next` passes on what the op had crossed.
export const makeOp = (key: PropertyKey, payload: unknown, handlers?: readonly HandlerNode[]) =>
  new KyootImpl({ _tag: "op", effectKey: key, payload, handlers });

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

// What a dropped continuation holds that must be unwound: the handler frames
// the op crossed, and escapes handled inside it whose handler had not yet
// resumed or finished. Innermost first.
type Drop = HandlerNode | EscapedOp;
const NoDrops: readonly Drop[] = [];
const PendingKey: unique symbol = Symbol("kyoot.pending");

// An op on its way out: the one-shot continuation from the op site to the
// frame that catches it. `captured` is the stack of the frame the throw
// abandoned; `onResume` is what an outer frame wraps around what it resumes
// with, when the op crossed one.
export class EscapedOp {
  readonly _tag = "EscapedOp";
  readonly key: PropertyKey;
  readonly payload: unknown;
  // The frames the op crossed, innermost first, so a fiber spawned by the op
  // can inherit them. Only an op built with a list collects.
  readonly handlers: HandlerNode[] | undefined;
  private readonly captured: Array<Continuation>;
  private readonly onResume: ((k: AnyKyoot) => AnyKyoot) | undefined;
  // Set only on an escape that crossed a frame, so the common one stays small.
  declare drops: readonly Drop[] | undefined;
  declare used: boolean | undefined;
  declare dropped: boolean | undefined;
  constructor(
    captured: Array<Continuation>,
    key: PropertyKey,
    payload: unknown,
    onResume?: (k: AnyKyoot) => AnyKyoot,
    handlers?: HandlerNode[],
    drops?: readonly Drop[],
  ) {
    this.captured = captured;
    this.key = key;
    this.payload = payload;
    this.onResume = onResume;
    this.handlers = handlers;
    if (drops !== undefined) this.drops = drops;
  }
  resumeWith(k: AnyKyoot): AnyKyoot {
    if (this.used) throw new Error("continuation resumed twice (one-shot law)");
    if (this.dropped) throw new Error("continuation resumed after it was dropped");
    this.used = true;
    return reify(this.captured, this.onResume === undefined ? k : this.onResume(k));
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

// An async driver sets a step budget; when a program runs past it, stepAll
// escapes with this key so the driver can let other fibers run.
export const yieldKey: unique symbol = Symbol("kyoot.yield");

let remaining = Infinity;

export function withBudget<T>(steps: number, f: () => T): T {
  const prev = remaining;
  remaining = steps;
  try {
    return f();
  } finally {
    remaining = prev;
  }
}

const reify = (conts: Array<Continuation>, inner: AnyKyoot): AnyKyoot => {
  for (let i = conts.length - 1; i >= 0; i--) {
    inner = new KyootImpl({ _tag: "map", self: inner, mapper: conts[i]! });
  }
  return inner;
};

// Past the budget. Resumed with a value, carry on from `here`; resumed with
// an error (an interrupt), raise it here.
const yieldEscape = (continuations: Array<Continuation>, here: AnyKyoot) =>
  new EscapedOp(continuations, yieldKey, undefined, (k) => k.map(() => here));

// Run `pre` first, if there is one, then `f`. With no `pre`, `f` runs now,
// so a throw in it stays synchronous.
const after = (pre: AnyKyoot | undefined, f: () => unknown): AnyKyoot =>
  pre === undefined ? (f() as AnyKyoot) : pre.map(f);

// A handler that finishes without resuming drops the continuation it holds.
// Unwind it as an interrupt would: every frame's `onInterrupt`, innermost
// first, and the same for escapes still pending inside it. Returns the
// program that does so, or undefined when there is nothing to run.
const unwind = (drops: readonly Drop[]): AnyKyoot | undefined => {
  let out: AnyKyoot | undefined;
  const then = (step: () => AnyKyoot | undefined) => {
    out = after(out, () => succeed(undefined).map(step));
  };
  for (const d of drops) {
    if (d instanceof EscapedOp) {
      if (d.used || d.dropped) continue;
      d.dropped = true;
      const inner = unwind(d.drops ?? NoDrops);
      if (inner !== undefined) then(() => inner);
    } else if (d.onInterrupt !== undefined) {
      const { onInterrupt, state } = d;
      then(() => {
        const fin = onInterrupt(state);
        return isKyoot(fin) ? fin : undefined;
      });
    }
  }
  return out;
};

// Close a handler's `onOp` program in a frame. An escape from the program
// crosses this frame, so an outer drop runs its onInterrupt and unwinds the
// inner escape without scanning the continuation stack.
const settle = (e: EscapedOp, k: AnyKyoot): AnyKyoot =>
  makeHandler(PendingKey, k, {
    initial: e,
    fork: "none",
    onOp: (_payload, resume) => resume(undefined),
    onSuccess: (v: unknown) => (e.used ? succeed(v) : after(unwind([e]), () => succeed(v))),
    onDefect: (d) =>
      after(unwind([e]), () => {
        throw d;
      }),
    onInterrupt: () => unwind([e]),
  });

// The frame again, around what its program continues with.
const rewrap = (handler: HandlerNode, self: AnyKyoot, state: unknown): AnyKyoot =>
  new KyootImpl({ ...handler, self, state });

// A throw inside onOp, or any exception that is not one of our two control
// exceptions, is a defect of the handler's scope.
const defect = (handler: HandlerNode, d: unknown): AnyKyoot => {
  if (handler.onDefect === undefined) throw d;
  return handler.onDefect(d, handler.state);
};

// `resume(v, st)` sets the state to `st` when given, even `undefined`; left
// out, the state stays. Plain functions, so `arguments.length` tells the two
// apart without a rest array per call.
const makeResume = (e: EscapedOp, handler: HandlerNode) => {
  const resumeWith = function (k: AnyKyoot, state?: unknown): AnyKyoot {
    return rewrap(handler, e.resumeWith(k), arguments.length > 1 ? state : handler.state);
  };
  const resume = function (v: unknown, state?: unknown): AnyKyoot {
    return resumeWith(succeed(v), arguments.length > 1 ? state : handler.state);
  };
  resume.with = resumeWith;
  return resume;
};

// What a frame does with what its program threw: answer its own op, pass on
// another frame's, finish an interrupt, or treat anything else as a defect.
const caught = (continuations: Array<Continuation>, handler: HandlerNode, e: unknown): AnyKyoot => {
  if (e instanceof InterruptedError) {
    const fin = handler.onInterrupt?.(handler.state);
    return after(isKyoot(fin) ? fin : undefined, () => {
      throw e;
    });
  }
  if (!(e instanceof EscapedOp)) return defect(handler, e);
  // A frame an op that collects frames meets is one a fiber it spawns
  // inherits, whether the frame answers the op or passes it on.
  if (e.handlers !== undefined && handler.fork !== "none") e.handlers.push(handler);
  if (e.key !== handler.effectKey) {
    throw new EscapedOp(
      continuations,
      e.key,
      e.payload,
      (k) => rewrap(handler, e.resumeWith(k), handler.state),
      e.handlers,
      [...(e.drops ?? NoDrops), handler],
    );
  }
  try {
    const handled = handler.onOp(e.payload, makeResume(e, handler), handler.state, e.handlers);
    return e.used || e.drops === undefined ? handled : settle(e, handled);
  } catch (d) {
    return after(unwind([e]), () => defect(handler, d));
  }
};

export function stepAll(k: AnyKyoot): unknown {
  const continuations: Array<Continuation> = [];
  let current: AnyKyoot = k;

  while (true) {
    if (--remaining < 0) throw yieldEscape(continuations, current);
    const currentNode = current[NodeSym];
    switch (currentNode._tag) {
      case "pure": {
        // A plain value from a mapper feeds the next one here, with no `pure`
        // node in between. Past the budget, box it and let the loop yield.
        let out: unknown = currentNode.value;
        let f = continuations.pop();
        while (true) {
          if (f === undefined) return out;
          out = f(out);
          if (isKyoot(out)) {
            current = out;
            break;
          }
          if (--remaining < 0) {
            current = succeed(out);
            break;
          }
          f = continuations.pop();
        }
        break;
      }
      case "map": {
        continuations.push(currentNode.mapper);
        current = currentNode.self;
        break;
      }
      case "op": {
        throw new EscapedOp(
          continuations,
          currentNode.effectKey,
          currentNode.payload,
          undefined,
          currentNode.handlers && [...currentNode.handlers],
        );
      }
      case "raise": {
        throw currentNode.error;
      }
      case "handler": {
        let handler: HandlerNode = currentNode;
        if (!handler.entered) handler = { ...handler, state: handler.create?.(), entered: true };
        let inner: unknown;
        try {
          inner = stepAll(handler.self);
        } catch (e) {
          current = caught(continuations, handler, e);
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
