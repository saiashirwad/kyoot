import type { AnyKyoot, HandlerHooks, Kyoot, OnOp, RowsOf, ValueOf } from "./model.ts";
import type { Answer, MergeAll, Only, Op, Payload, Row, Simplify } from "./types.ts";

type RuntimeNode =
  | { readonly _tag: "pure"; readonly a: unknown }
  | { readonly _tag: "map"; readonly a: AnyKyoot; readonly b: (a: unknown) => unknown }
  | { readonly _tag: "flatMap"; readonly a: AnyKyoot; readonly b: (a: unknown) => AnyKyoot }
  | { readonly _tag: "gen"; readonly a: () => Generator<AnyKyoot, unknown, unknown> }
  | { readonly _tag: "op"; readonly a: PropertyKey; readonly b: unknown; readonly c: number }
  | {
      readonly _tag: "handler";
      readonly a: AnyKyoot;
      readonly b: PropertyKey;
      readonly c: HandlerHooks;
    }
  | { readonly _tag: "catch"; readonly a: AnyKyoot; readonly b: (d: unknown) => AnyKyoot }
  | { readonly _tag: "ensure"; readonly a: AnyKyoot; readonly b: AnyKyoot }
  | {
      readonly _tag: "resume" | "resumeWith";
      readonly a: unknown;
      readonly b: unknown;
      readonly c: unknown;
    }
  | { readonly _tag: "raise"; readonly a: unknown };

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

  throw(e: unknown): IteratorResult<Kyoot<unknown, S>, A> {
    throw e;
  }
}

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

  pipe(...fns: Array<(x: any) => any>): any {
    return fns.reduce((value, fn) => fn(value), this);
  }

  [Symbol.iterator]() {
    return new KyootIterator<A, S>(this);
  }
}

export const node = (k: AnyKyoot): RuntimeNode => k as unknown as RuntimeNode;

export const isKyoot = (value: unknown): value is AnyKyoot => value instanceof KyootImpl;

export const succeed = <A>(value: A): Kyoot<A, {}> => new KyootImpl("pure", value);

export const unit: Kyoot<void, {}> = succeed(undefined);

export const withState = <A, St>(a: A, state: St) => succeed([a, state] as const);

export const raise = (error: unknown): Kyoot<never, {}> => new KyootImpl("raise", error);

export const makeOp = (key: PropertyKey, payload: unknown, skip = 0) =>
  new KyootImpl("op", key, payload, skip);

export const gen = <A, Y extends AnyKyoot>(
  f: () => Generator<Y, A, unknown>,
): Kyoot<A, MergeAll<RowsOf<Y>>> => new KyootImpl("gen", f) as never;

export const op =
  <A>() =>
  <const K extends string, P>(key: K, payload: P): Kyoot<A, { [k in K]: Op<P, A> }> =>
    makeOp(key, payload) as Kyoot<A, { [k in K]: Op<P, A> }>;

export const catchDefect = <A, S extends Row, B, S2 extends Row>(
  k: Kyoot<A, S>,
  f: (defect: unknown) => Kyoot<B, S2>,
): Kyoot<A | B, MergeAll<S | S2>> => new KyootImpl("catch", k, f) as never;

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

type Performed<K extends string, P, A, C extends Row> = Kyoot<
  A,
  Simplify<{ [k in K]: Op<P, A> } & C>
>;

interface Cell<St> {
  readonly create: () => St;
}

type Interceptor<K extends string, P, A, C extends Row, St, Ret> = (
  payload: P,
  next: (payload: P) => Performed<K, P, A, C>,
  state: St,
) => Ret;

type Interception<K extends string, P, A, Ret> = <B, S extends Row & { [k in K]?: Op<P, A> }>(
  k: Kyoot<B, S>,
) => Kyoot<B, MergeAll<Omit<S, K> | RowsOf<Ret>>>;

export interface Intercept<K extends string, P, A, C extends Row = {}> {
  <Ret extends Kyoot<A, any>>(
    f: Interceptor<K, P, A, C, undefined, Ret>,
  ): Interception<K, P, A, Ret>;
  <St, Ret extends Kyoot<A, any>>(
    cell: Cell<St>,
    f: Interceptor<K, P, A, C, St, Ret>,
  ): Interception<K, P, A, Ret>;
}

export const makeIntercept = <K extends string, P, A, C extends Row = {}>(
  key: K,
): Intercept<K, P, A, C> => {
  type F = Interceptor<K, P, A, C, any, AnyKyoot>;
  const nexts: Array<(p: P) => never> = [];
  const nextPast = (past: number) => (nexts[past] ??= (p: P) => makeOp(key, p, past) as never);
  return (cellOrF: Cell<unknown> | F, maybeF?: F) => {
    const cell = typeof cellOrF === "function" ? undefined : cellOrF;
    const f = typeof cellOrF === "function" ? cellOrF : maybeF!;
    const onOp: OnOp = (payload, resume, state, past) =>
      resume.with(f(payload, nextPast(past), state));
    return (k: AnyKyoot) => makeHandler(key, k, { create: cell?.create, onOp: onOp as never });
  };
};

interface State<St> {
  initial?: St;
  create?: () => St;
  fork?: HandlerHooks["fork"];
}

interface OpHooks<P, A, St, C extends Row, ROp extends AnyKyoot> extends State<St> {
  onOp: (payload: P, resume: Resume<A, St, C>, state: St) => ROp;
}

interface TailHooks<P, A, St> extends State<St> {
  tail: (payload: P, state: St) => NoInfer<A>;
}

type Hooks<P, A, St, C extends Row, ROp extends AnyKyoot> =
  | OpHooks<P, A, St, C, ROp>
  | TailHooks<P, A, St>;

type Nothing = Kyoot<never, {}>;

export const effect =
  <P, A, C extends Row = {}>() =>
  <const K extends string>(key: K) => {
    const perform = (payload: P) => makeOp(key, payload) as Performed<K, P, A, C>;
    const handle =
      <St = undefined, ROp extends AnyKyoot = Nothing>(hooks: Hooks<P, A, St, C, ROp>) =>
      <B, S extends Row & { [k in K]?: Op<P, A> }>(k: Kyoot<B, S>) =>
        makeHandler<K, B, S, St, P, A, C, ROp>(key, k, hooks);
    return Object.assign(perform, { key, handle, intercept: makeIntercept<K, P, A, C>(key) });
  };

const handler = (key: PropertyKey, self: AnyKyoot, hooks: HandlerHooks): AnyKyoot =>
  new KyootImpl("handler", self, key, hooks);

export function makeHandler<
  K extends PropertyKey,
  A,
  S extends Row,
  St = undefined,
  P = Payload<S, K>,
  R = Answer<S, K>,
  C extends Row = Row,
  ROp extends AnyKyoot = Nothing,
  RReturn extends AnyKyoot = Kyoot<A, {}>,
>(
  effectKey: K,
  self: Kyoot<A, S>,
  hooks: Hooks<P, R, St, C, ROp> & {
    onReturn?: (a: A, state: St) => RReturn;
  },
): Kyoot<ValueOf<RReturn> | ValueOf<ROp>, MergeAll<Omit<S, K> | RowsOf<ROp> | RowsOf<RReturn>>> {
  return handler(effectKey, self, hooks as unknown as HandlerHooks) as never;
}

export const collect =
  <const K extends string>(key: K) =>
  <A, S extends Row & { [k in K]?: Op<unknown, void> }>(
    k: Kyoot<A, S>,
  ): Kyoot<readonly [A, Array<Payload<S, K>>], MergeAll<Omit<S, K>>> =>
    handler(key, k, {
      create: () => [],
      tail: (payload, payloads) => void payloads.push(payload),
      onReturn: withState,
    }) as never;

export const forEach =
  <const K extends string, P, R>(key: K, f: (payload: P) => R) =>
  <A, S extends Row & { [k in K]?: Op<P, void> }>(
    k: Kyoot<A, S>,
  ): Kyoot<A, MergeAll<Omit<S, K> | RowsOf<R>>> =>
    handler(key, k, {
      onOp: (payload, resume) => {
        const r = f(payload);
        return isKyoot(r) ? r.flatMap(() => resume(undefined)) : resume(undefined);
      },
    }) as never;
