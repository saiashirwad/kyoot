import type {
  AnyKyoot,
  Fork,
  HandlerHooks,
  Kyoot,
  OnOp,
  RowsOf,
  Snapshot,
  ValueOf,
} from "./model.ts";
import type { Pipeable } from "./pipe.ts";
import type { MergeAll, Only, Row, Simplify } from "./types.ts";

// What each node's slots hold. One runtime shape keeps the machine's loads monomorphic.
export type RuntimeNode =
  | { readonly _tag: "pure"; readonly a: unknown }
  | { readonly _tag: "map"; readonly a: AnyKyoot; readonly b: (a: unknown) => unknown }
  | { readonly _tag: "flatMap"; readonly a: AnyKyoot; readonly b: (a: unknown) => AnyKyoot }
  | { readonly _tag: "gen"; readonly a: () => Generator<AnyKyoot, unknown, unknown> }
  // c: how many handlers for the key to pass over before one answers.
  | { readonly _tag: "op"; readonly a: PropertyKey; readonly b: unknown; readonly c: number }
  | {
      readonly _tag: "handler";
      readonly a: AnyKyoot;
      readonly b: PropertyKey;
      readonly c: HandlerHooks;
    }
  | { readonly _tag: "catch"; readonly a: AnyKyoot; readonly b: (d: unknown) => AnyKyoot }
  | { readonly _tag: "ensure"; readonly a: AnyKyoot; readonly b: AnyKyoot }
  // a: the operation it answers; b: the value (resume) or program (resumeWith); c: new state or KEEP.
  | {
      readonly _tag: "resume" | "resumeWith";
      readonly a: unknown;
      readonly b: unknown;
      readonly c: unknown;
    }
  | { readonly _tag: "raise"; readonly a: unknown };

export const KEEP: unique symbol = Symbol("kyoot.keep");

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

  // A defect thrown into the generator surfaces at its `yield*`.
  throw(e: unknown): IteratorResult<Kyoot<unknown, S>, A> {
    throw e;
  }
}

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

  map(mapper: (a: A) => any): any {
    return new KyootImpl("map", this, mapper);
  }

  flatMap(mapper: (a: A) => AnyKyoot): any {
    return new KyootImpl("flatMap", this, mapper);
  }

  [Symbol.iterator]() {
    return new KyootIterator<A, S>(this);
  }
}

KyootImpl.prototype.pipe = function (this: unknown, ...fns: Array<(x: any) => any>) {
  return fns.reduce((value, fn) => fn(value), this);
};

export const node = (k: AnyKyoot): RuntimeNode => k as unknown as RuntimeNode;

export const isKyoot = (value: unknown): value is AnyKyoot => value instanceof KyootImpl;

export const succeed = <A>(value: A): Kyoot<A, {}> => new KyootImpl("pure", value);

export const unit: Kyoot<void, {}> = succeed(undefined);

// For `onReturn`: the result, beside the state the handler ended with.
export const withState = <A, St>(a: A, state: St) => succeed([a, state] as const);

export const raise = (error: unknown): Kyoot<never, {}> => new KyootImpl("raise", error);

export const makeOp = (key: PropertyKey, payload: unknown, skip = 0) =>
  new KyootImpl("op", key, payload, skip);

export const genNode = (factory: () => Generator<AnyKyoot, unknown, unknown>): AnyKyoot =>
  new KyootImpl("gen", factory);

export const gen = <A, Y extends AnyKyoot>(
  f: () => Generator<Y, A, unknown>,
): Kyoot<A, MergeAll<RowsOf<Y>>> =>
  genNode(f as () => Generator<AnyKyoot, unknown, unknown>) as never;

export const op =
  <A>() =>
  <const K extends string, P>(key: K, payload: P): Kyoot<A, { [k in K]: P }> =>
    makeOp(key, payload) as Kyoot<A, { [k in K]: P }>;

// A defect is anything thrown. `f` sees it in place of `k`'s result; interruption passes by.
export const catchDefect = <A, S extends Row, B, S2 extends Row>(
  k: Kyoot<A, S>,
  f: (defect: unknown) => Kyoot<B, S2>,
): Kyoot<A | B, MergeAll<S | S2>> => new KyootImpl("catch", k, f) as never;

// `cleanup` runs however `k` ends: a result, a defect, an abort, or an interrupt. Like a
// `finally`, a defect it raises replaces the outcome it was cleaning up after.
export const ensuring = <A, S extends Row, S2 extends Row>(
  k: Kyoot<A, S>,
  cleanup: Kyoot<unknown, S2>,
): Kyoot<A, MergeAll<S | S2>> => new KyootImpl("ensure", k, cleanup) as never;

export interface Resume<A, St, C extends Row = Row> {
  (value: A, state?: St): Kyoot<never, {}>;
  with<S extends Row & Partial<C>>(
    program: Kyoot<A, S> & Only<S, keyof C>,
    state?: St,
  ): Kyoot<never, {}>;
}

type Performed<K extends string, V, A, C extends Row> = Kyoot<A, Simplify<{ [k in K]: V } & C>>;

export interface Cell<St> {
  readonly create: () => St;
  readonly fork?: Fork;
}

type Interceptor<K extends string, P, V, A, C extends Row, St, Ret> = (
  payload: P,
  next: (payload: P) => Performed<K, V, A, C>,
  state: St,
) => Ret;

type Interception<K extends string, V, Ret> = <B, S extends Row & { [k in K]?: V }>(
  k: Kyoot<B, S>,
) => Kyoot<B, MergeAll<Omit<S, K> | RowsOf<Ret>>>;

export interface Intercept<K extends string, P, A, C extends Row = {}, V = P> {
  <Ret extends Kyoot<A, any>>(
    f: Interceptor<K, P, V, A, C, undefined, Ret>,
  ): Interception<K, V, Ret>;
  <St, Ret extends Kyoot<A, any>>(
    cell: Cell<St>,
    f: Interceptor<K, P, V, A, C, St, Ret>,
  ): Interception<K, V, Ret>;
}

// An interceptor's program runs at the op, as if the op had been written as that
// program: what it performs, and what `next` performs past this handler, meets the
// handlers the op itself would have met.
export const makeIntercept = <K extends string, P, A, C extends Row = {}, V = P>(
  key: K,
): Intercept<K, P, A, C, V> => {
  type F = Interceptor<K, P, V, A, C, any, AnyKyoot>;
  const nexts: Array<(p: P) => never> = [];
  const nextPast = (past: number) => (nexts[past] ??= (p: P) => makeOp(key, p, past) as never);
  return (cellOrF: Cell<unknown> | F, maybeF?: F) => {
    const cell = typeof cellOrF === "function" ? undefined : cellOrF;
    const f = typeof cellOrF === "function" ? cellOrF : maybeF!;
    const onOp: OnOp = (payload, resume, state, past) =>
      resume.with(f(payload, nextPast(past), state));
    return (k: AnyKyoot) =>
      makeHandler(key, k, { create: cell?.create, fork: cell?.fork, onOp: onOp as never });
  };
};

interface State<St> {
  initial?: St;
  create?: () => St;
  fork?: Fork;
}

export interface OpHooks<P, A, St, C extends Row, ROp extends AnyKyoot> extends State<St> {
  onOp: (payload: P, resume: Resume<A, St, C>, state: St) => ROp;
}

// A handler that answers every op with a value, right where it was performed: a throw
// lands at the op. It may change mutable state; it cannot replace it.
export interface TailHooks<P, A, St> extends State<St> {
  tail: (payload: P, state: St) => A;
}

export type Hooks<P, A, St, C extends Row, ROp extends AnyKyoot> =
  | OpHooks<P, A, St, C, ROp>
  | TailHooks<P, A, St>;

type Nothing = Kyoot<never, {}>;

export const effect =
  <P, A, C extends Row = {}, V = P>() =>
  <const K extends string>(key: K) => {
    const perform = (payload: P) => makeOp(key, payload) as Performed<K, V, A, C>;
    const handle =
      <St = undefined, ROp extends AnyKyoot = Nothing>(hooks: Hooks<P, A, St, C, ROp>) =>
      <B, S extends Row & { [k in K]?: V }>(k: Kyoot<B, S>) =>
        makeHandler(key, k, hooks);
    return Object.assign(perform, { key, handle, intercept: makeIntercept<K, P, A, C, V>(key) });
  };

export type Payload<S, K extends PropertyKey> = K extends keyof S
  ? Exclude<S[K], undefined>
  : never;

export function makeHandler<
  K extends PropertyKey,
  A,
  S extends Row,
  St = undefined,
  P = Payload<S, K>,
  C extends Row = Row,
  ROp extends AnyKyoot = Nothing,
  RReturn extends AnyKyoot = Kyoot<A, {}>,
>(
  effectKey: K,
  self: Kyoot<A, S>,
  hooks: Hooks<P, any, St, C, ROp> & {
    onReturn?: (a: A, state: St) => RReturn;
  },
): Kyoot<ValueOf<RReturn> | ValueOf<ROp>, MergeAll<Omit<S, K> | RowsOf<ROp> | RowsOf<RReturn>>> {
  return new KyootImpl("handler", self, effectKey, hooks as unknown as HandlerHooks) as never;
}

export class InterruptedError extends Error {
  readonly _tag = "InterruptedError";
  constructor(message = "fiber interrupted") {
    super(message);
    this.name = "InterruptedError";
  }
}

// Installs, around `k`, what a fiber inherits from the handlers it was forked under:
// innermost first, so they nest as they did at the fork.
export const inherit = (k: AnyKyoot, snapshots: readonly Snapshot[] = []): AnyKyoot => {
  for (const { key, hooks, state } of snapshots) {
    const fork = hooks.fork;
    k =
      typeof fork === "function"
        ? fork(k)
        : makeHandler(key, k, {
            initial: state,
            fork,
            onOp: hooks.onOp,
            tail: hooks.tail,
          } as never);
  }
  return k;
};

// Answers each op for `key` with nothing, keeping its payloads in order beside the result.
export const collect =
  <const K extends string>(key: K) =>
  <A, S extends Row & { [k in K]?: unknown }>(
    k: Kyoot<A, S>,
  ): Kyoot<readonly [A, Array<Payload<S, K>>], MergeAll<Omit<S, K>>> =>
    makeHandler(key, k, {
      create: () => [] as unknown[],
      tail: (payload, payloads) => void payloads.push(payload),
      onReturn: withState,
    }) as never;

// Answers each op for `key` once `f` has seen its payload, and has run, if `f` returns
// one, the program it returned.
export const forEach =
  <const K extends string, P, R>(key: K, f: (payload: P) => R) =>
  <A, S extends Row & { [k in K]?: P }>(
    k: Kyoot<A, S>,
  ): Kyoot<A, MergeAll<Omit<S, K> | RowsOf<R>>> =>
    makeHandler(key, k, {
      onOp: (payload, resume) => {
        const r = f(payload as P);
        return isKyoot(r) ? r.flatMap(() => resume(undefined)) : resume(undefined);
      },
    }) as never;
