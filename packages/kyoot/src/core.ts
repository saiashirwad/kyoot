import {
  NodeSym,
  type AnyKyoot,
  type ForkMode,
  type HandlerHooks,
  type Kyoot,
  type OnOp,
  type RowOf,
  type RowsOf,
  type RuntimeNode,
  type RuntimeResume,
  type Snapshot,
  type ValueOf,
} from "./model.ts";
import { pipeArguments, type Pipeable } from "./pipe.ts";
import type { MergeAll, Only, Row, Simplify } from "./types.ts";

// One `yield*` on a program: hand the program out, then hand the answer
// back. The iterator is also its result object; `yield*` reads it before `next`.
class KyootIterator<A, S extends Row> implements Iterator<Kyoot<unknown, S>, A, unknown> {
  private used = false;
  done = false;
  value: unknown;

  constructor(k: Kyoot<unknown, S>) {
    this.value = k;
  }

  next(v?: unknown): IteratorResult<Kyoot<unknown, S>, A> {
    if (this.used) {
      this.done = true;
      this.value = v;
    } else {
      this.used = true;
    }
    return this as unknown as IteratorResult<Kyoot<unknown, S>, A>;
  }
}

// The interface carries pipe's overloads; the class merges with it.
// oxlint-disable-next-line no-unused-vars, typescript/no-unsafe-declaration-merging
export interface KyootImpl<A, S extends Row = {}> extends Pipeable {}
export class KyootImpl<A, S extends Row = {}> implements Kyoot<A, S> {
  readonly _tag: RuntimeNode["_tag"];
  readonly a: unknown;
  readonly b: unknown;
  readonly c: unknown;

  constructor(_tag: RuntimeNode["_tag"], a: unknown, b?: unknown, c?: unknown) {
    this._tag = _tag;
    this.a = a;
    this.b = b;
    this.c = c;
  }

  get [NodeSym](): RuntimeNode {
    // Constructors below establish the slot types for each tag.
    return this as unknown as RuntimeNode;
  }

  // Parameter typed by A so a KyootImpl never infers A as `any` downstream;
  // return types stay `any` so the class does not repeat Kyoot's row math.
  map(mapper: (a: A) => any): any {
    return new KyootImpl("map", this as AnyKyoot, mapper);
  }

  flatMap(mapper: (a: A) => AnyKyoot): any {
    return new KyootImpl("flatMap", this as AnyKyoot, mapper);
  }

  [Symbol.iterator]() {
    return new KyootIterator<A, S>(this);
  }
}

export const isKyoot = (value: unknown): value is AnyKyoot => value instanceof KyootImpl;

export const succeed = <A>(value: A): Kyoot<A, {}> => new KyootImpl("pure", value);

// An op built with a `handlers` list collects the frames it crosses on its
// way out (see Machine), so a fiber it spawns can inherit them. `async` is
// one; an interceptor's `next` passes on what the op had crossed.
export const makeOp = (key: PropertyKey, payload: unknown, handlers?: readonly Snapshot[]) =>
  new KyootImpl("op", key, payload, handlers);

export const genNode = (factory: () => Generator<AnyKyoot, unknown, unknown>): AnyKyoot =>
  new KyootImpl("gen", factory);

// A fresh generator per run; the machine keeps it as a frame on its stack.
export const gen = <A, Y extends AnyKyoot>(
  f: () => Generator<Y, A, unknown>,
): Kyoot<A, MergeAll<RowsOf<Y>>> =>
  genNode(f as () => Generator<AnyKyoot, unknown, unknown>) as never;

// Typed op constructor. The row records the key and the payload type, so a
// handler's `onOp` can read the payload type back off the row. `A` is what
// the op resumes with; TS can't infer it, hence the two-step call.
export const op =
  <A>() =>
  <const K extends string, P>(key: K, payload: P): Kyoot<A, { [k in K]: P }> =>
    makeOp(key, payload) as Kyoot<A, { [k in K]: P }>;

// Failure is part of the model: an effect's contract names it, and an
// interceptor delivers one where the op was performed. The op lives here so
// no effect module has to reach into another's key.
export const fail = <E>(e: E) => op<never>()("fail", e);

// resume's result is opaque: the handler's type comes from `self`, not from
// what resume hands back. Returning `never` keeps it out of inference.
// `resume.with` continues the program with a computation instead of a value,
// run where the op was performed, so the program's own handlers see it. `C`
// is the effect's contract: the row a handed-back program may use, since the
// op site was told to expect it. A key outside it is named in the error.
export interface Resume<A, St, C extends Row = Row> {
  (value: A, state?: St): Kyoot<never, {}>;
  with<S extends Row & Partial<C>>(
    program: Kyoot<A, S> & Only<S, keyof C>,
    state?: St,
  ): Kyoot<never, {}>;
}

// `V` is what the row records for the key: the payload, unless the module
// records something else, as Env and Var do. Performing the op puts the key
// and the contract in the row. The key stays its own parameter everywhere
// below so a `Tag<"db">` is a `Tag<string>`: variance is measured per
// parameter, and the payload is both an input and an output.
type Performed<K extends string, V, A, C extends Row> = Kyoot<A, Simplify<{ [k in K]: V } & C>>;

// A cell for `intercept`: `create` runs when the frame is entered, so each
// run gets its own; `fork` says what a fiber gets (see Hooks).
export interface Cell<St> {
  readonly create: () => St;
  readonly fork?: ForkMode;
}

type Interceptor<K extends string, P, V, A, C extends Row, St, Ret> = (
  payload: P,
  next: (payload: P) => Performed<K, V, A, C>,
  state: St,
) => Ret;

// An interceptor removes K from the row and adds whatever `f` performs.
type Interception<K extends string, V, Ret> = <B, S extends Row & { [k in K]?: V }>(
  k: Kyoot<B, S>,
) => Kyoot<B, MergeAll<Omit<S, K> | RowOf<Ret>>>;

// `f`'s return is inferred whole, then split into value and row: a union of
// programs (a ternary) infers cleanly that way, and not as `Kyoot<A, S>`.
export interface Intercept<K extends string, P, A, C extends Row = {}, V = P> {
  <Ret extends Kyoot<A, any>>(
    f: Interceptor<K, P, V, A, C, undefined, Ret>,
  ): Interception<K, V, Ret>;
  <St, Ret extends Kyoot<A, any>>(
    cell: Cell<St>,
    f: Interceptor<K, P, V, A, C, St, Ret>,
  ): Interception<K, V, Ret>;
}

// Build `intercept` for a key. Whatever `f` does, its outcome is delivered
// where the op was performed: a value resumes, a failure is raised there
// for the program to catch. `fail` is special: the op site is the failure
// itself, so `f`'s program is the answer and runs outside the frame. `next`
// re-performs the op with the frames it had crossed, so a fiber forked
// through an interceptor inherits them, and the interceptor.
export const makeIntercept = <K extends string, P, A, C extends Row = {}, V = P>(
  key: K,
): Intercept<K, P, A, C, V> => {
  type F = Interceptor<K, P, V, A, C, any, AnyKyoot>;
  const deliver =
    key === "fail"
      ? (k: AnyKyoot) => k
      : (k: AnyKyoot, resume: RuntimeResume): AnyKyoot =>
          makeHandler("fail", k, {
            onOp: (e) => resume.with(fail(e)),
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
// run and shared with fibers forked under the handler. Each hook's return
// is inferred whole (see Intercept); a hook that returns instead of
// resuming adds its value and row to the handler's.
export interface Hooks<
  P,
  A,
  St,
  C extends Row,
  ROp extends AnyKyoot,
  RDefect extends AnyKyoot,
  RInterrupt extends void | AnyKyoot,
> {
  initial?: St;
  create?: () => St;
  fork?: ForkMode;
  onOp: (payload: P, resume: Resume<A, St, C>, state: St) => ROp;
  onDefect?: (d: unknown, state: St) => RDefect;
  onInterrupt?: (state: St) => RInterrupt;
}

type Nothing = Kyoot<never, {}>;

// A declared effect. Calling it performs the op; `handle` builds a handler
// whose `resume` is typed to the answer and the contract; `intercept` sits
// between the program and the handlers outside it: `next` performs the op
// again for them to answer. `intercept({ create }, f)` hands `f` a cell as
// its third argument: made fresh per run, shared with fibers forked under
// it. A cache is one.
export const effect =
  <P, A, C extends Row = {}, V = P>() =>
  <const K extends string>(key: K) => {
    const perform = (payload: P) => makeOp(key, payload) as Performed<K, V, A, C>;
    const handle =
      <
        St = undefined,
        ROp extends AnyKyoot = Nothing,
        RDefect extends AnyKyoot = Nothing,
        RInterrupt extends void | AnyKyoot = void,
      >(
        hooks: Hooks<P, A, St, C, ROp, RDefect, RInterrupt>,
      ) =>
      <B, S extends Row & { [k in K]?: V }>(k: Kyoot<B, S>) =>
        makeHandler(key, k, hooks);
    return Object.assign(perform, { key, handle, intercept: makeIntercept<K, P, A, C, V>(key) });
  };

// The payload type an effect key carries in the row, if the row has it.
export type Payload<S, K extends PropertyKey> = K extends keyof S
  ? Exclude<S[K], undefined>
  : never;

// Build a handler node and infer its type: the result is what onSuccess
// returns (default: the inner value) plus anything onOp / onDefect
// short-circuit with; the row is the inner row minus K plus whatever the
// hooks introduce.
export function makeHandler<
  K extends PropertyKey,
  A,
  S extends Row,
  St = undefined,
  // Ops built with `op` put their payload type in the row, so this default is
  // right for them. Var records the state type and annotates the payload.
  P = Payload<S, K>,
  C extends Row = Row,
  ROp extends AnyKyoot = Nothing,
  RSuccess extends AnyKyoot = Kyoot<A, {}>,
  RDefect extends AnyKyoot = Nothing,
  RInterrupt extends void | AnyKyoot = void,
>(
  effectKey: K,
  self: Kyoot<A, S>,
  hooks: Hooks<P, any, St, C, ROp, RDefect, RInterrupt> & {
    onSuccess?: (a: A, state: St) => RSuccess;
  },
): Kyoot<
  ValueOf<RSuccess> | ValueOf<ROp> | ValueOf<RDefect>,
  MergeAll<Omit<S, K> | RowOf<ROp> | RowOf<RSuccess> | RowOf<RDefect> | RowOf<RInterrupt>>
> {
  // The public hook type is more precise than the machine's erased runtime
  // view. The same record is stored; handler construction adds no wrapper.
  return new KyootImpl("handler", self, effectKey, hooks as unknown as HandlerHooks) as never;
}

export class InterruptedError extends Error {
  readonly _tag = "InterruptedError";
  constructor(message = "fiber interrupted") {
    super(message);
    this.name = "InterruptedError";
  }
}

// Wrap a fiber's program in the handlers that enclosed the fork, outermost
// last. `scope`: the handler over again, end hooks and all. `copy` (the
// default): the same `onOp` on the state as it was, no end hooks. `none`
// never gets this far: the machine leaves it out when it takes snapshots.
export const inherit = (k: AnyKyoot, snapshots: readonly Snapshot[] = []): AnyKyoot => {
  for (const { node, state } of snapshots) {
    const hooks = node.c;
    const copied: HandlerHooks = { initial: state, fork: hooks.fork, onOp: hooks.onOp };
    k = makeHandler(node.b, k, (hooks.fork === "scope" ? hooks : copied) as never);
  }
  return k;
};

KyootImpl.prototype.pipe = function (this: unknown, ...fns: Array<(x: any) => any>) {
  return pipeArguments(this, fns);
};
