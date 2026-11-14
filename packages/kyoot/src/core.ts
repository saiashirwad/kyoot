import type { AnyKyoot, Kyoot, OnOp, RowsOf, ValueOf } from "./model.ts";
import type { MergeAll, Only, Op, Payload, Row, Simplify } from "./types.ts";

type RuntimeNode =
  | { readonly _tag: "pure"; readonly a: unknown }
  | { readonly _tag: "map"; readonly a: AnyKyoot; readonly b: (a: unknown) => unknown }
  | { readonly _tag: "flatMap"; readonly a: AnyKyoot; readonly b: (a: unknown) => AnyKyoot }
  | { readonly _tag: "gen"; readonly a: () => Generator<AnyKyoot, unknown, unknown> }
  | { readonly _tag: "op"; readonly a: PropertyKey; readonly b: unknown; readonly c: number }
  | { readonly _tag: "handler"; readonly a: AnyKyoot; readonly b: PropertyKey; readonly c: OnOp }
  | { readonly _tag: "catch"; readonly a: AnyKyoot; readonly b: (d: unknown) => AnyKyoot }
  | { readonly _tag: "ensure"; readonly a: AnyKyoot; readonly b: AnyKyoot }
  | { readonly _tag: "resume" | "resumeWith"; readonly a: unknown; readonly b: unknown }
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

export const raise = (error: unknown): Kyoot<never, {}> => new KyootImpl("raise", error);

export const makeOp = (key: PropertyKey, payload: unknown, skip = 0) =>
  new KyootImpl("op", key, payload, skip);

export const gen = <A, Y extends AnyKyoot>(
  f: () => Generator<Y, A, unknown>,
): Kyoot<A, MergeAll<RowsOf<Y>>> => new KyootImpl("gen", f);

export const op =
  <A>() =>
  <const K extends string, P>(key: K, payload: P): Kyoot<A, { [k in K]: Op<P, A> }> =>
    makeOp(key, payload) as Kyoot<A, { [k in K]: Op<P, A> }>;

export const catchDefect = <A, S extends Row, B, S2 extends Row>(
  k: Kyoot<A, S>,
  f: (defect: unknown) => Kyoot<B, S2>,
): Kyoot<A | B, MergeAll<S | S2>> => new KyootImpl("catch", k, f);

export const ensuring = <A, S extends Row, S2 extends Row>(
  k: Kyoot<A, S>,
  cleanup: Kyoot<unknown, S2>,
): Kyoot<A, MergeAll<S | S2>> => new KyootImpl("ensure", k, cleanup);

export interface Resume<A, C extends Row = Row> {
  (value: A): Kyoot<never, {}>;
  with<S extends Row & Partial<C>>(program: Kyoot<A, S> & Only<S, keyof C>): Kyoot<never, {}>;
}

type Performed<K extends string, P, A, C extends Row> = Kyoot<
  A,
  Simplify<{ [k in K]: Op<P, A> } & C>
>;

type Interceptor<K extends string, P, A, C extends Row, Ret> = (
  payload: P,
  next: (payload: P) => Performed<K, P, A, C>,
) => Ret;

type Interception<K extends string, P, A, Ret> = <B, S extends Row & { [k in K]?: Op<P, A> }>(
  k: Kyoot<B, S>,
) => Kyoot<B, MergeAll<Omit<S, K> | RowsOf<Ret>>>;

export type Intercept<K extends string, P, A, C extends Row = {}> = <Ret extends Kyoot<A, any>>(
  f: Interceptor<K, P, A, C, Ret>,
) => Interception<K, P, A, Ret>;

export const makeHandler = (key: PropertyKey, self: AnyKyoot, onOp: OnOp): AnyKyoot =>
  new KyootImpl("handler", self, key, onOp);

// A handler that always resumes at once with answer(payload); the machine skips the mask and resumer.
export const answering =
  <const K extends string, P, A>(
    key: K,
    answer: (payload: P) => A,
  ): Handle<K, P, A, Kyoot<never>> =>
  (k) => {
    const onOp: OnOp = (payload, resume) => resume(answer(payload));
    onOp.answer = answer;
    return makeHandler(key, k, onOp) as never;
  };

export const makeIntercept = <K extends string, P, A, C extends Row = {}>(
  key: K,
): Intercept<K, P, A, C> => {
  const nexts: Array<(p: P) => never> = [];
  const nextPast = (past: number) => (nexts[past] ??= (p: P) => makeOp(key, p, past) as never);
  return (f) => {
    const onOp: OnOp = (payload, resume, past) => resume.with(f(payload, nextPast(past)));
    return (k) => makeHandler(key, k, onOp) as never;
  };
};

export type Handle<K extends string, P, A, ROp> = <B, S extends Row & { [k in K]?: Op<P, A> }>(
  k: Kyoot<B, S>,
) => Kyoot<B | ValueOf<ROp>, MergeAll<Omit<S, K> | RowsOf<ROp>>>;

export const effect =
  <P, A, C extends Row = {}>() =>
  <const K extends string>(key: K) => {
    const perform = (payload: P) => makeOp(key, payload) as Performed<K, P, A, C>;
    const handle =
      <ROp extends AnyKyoot>(
        onOp: (payload: P, resume: Resume<A, C>) => ROp,
      ): Handle<K, P, A, ROp> =>
      (k) =>
        makeHandler(key, k, onOp as never) as never;
    const handleWith =
      <ROp extends AnyKyoot>(
        make: () => (payload: P, resume: Resume<A, C>) => ROp,
      ): Handle<K, P, A, ROp> =>
      (k) =>
        unit.flatMap(() => makeHandler(key, k, make() as never)) as never;
    return Object.assign(perform, {
      key,
      handle,
      handleWith,
      intercept: makeIntercept<K, P, A, C>(key),
    });
  };

// A declared effect, as effect<P, A, C>()(key) returns it.
type Declared = {
  readonly key: string;
  readonly handle: (...args: never) => unknown;
  readonly intercept: (...args: never) => unknown;
} & ((payload: never) => AnyKyoot);
type Effects = Record<string, Declared>;

// The runtime view of a declared effect, for the loops below.
type Wrap = (k: AnyKyoot) => AnyKyoot;
type Loose = {
  readonly key: string;
  readonly handle: (onOp: unknown) => Wrap;
  readonly intercept: (f: unknown) => Wrap;
};

type PayloadIn<E extends Declared> = Parameters<E>[0];
type AnswerIn<E extends Declared> = ValueOf<ReturnType<E>>;
type HandlerIn<E extends Declared> = Parameters<E["handle"]>[0];

// One handler per effect, keyed by the same names; payload, resume and answer come from the declarations.
export type Handlers<Es extends Effects> = { [N in keyof Es]: HandlerIn<Es[N]> };
// The row of a group: each effect's key mapped to its operation. Used to check the program's row.
type RowOf<Es extends Effects> = {
  [N in keyof Es as Es[N]["key"]]?: Op<PayloadIn<Es[N]>, AnswerIn<Es[N]>>;
};
type ReturnOf<F> = F extends (...args: never) => infer R ? Extract<R, AnyKyoot> : never;

// Handles a group of declared effects at once: one handler per effect, keyed by the same names.
// The handlers share whatever state their closure holds. Each is typed from its declaration.
export type HandleAll<Es extends Effects, R extends AnyKyoot> = <B, S extends Row & RowOf<Es>>(
  k: Kyoot<B, S>,
) => Kyoot<B | ValueOf<R>, MergeAll<Omit<S, Es[keyof Es]["key"]> | RowsOf<R>>>;

export const handleAll =
  <const Es extends Effects, H extends Handlers<Es>>(
    effects: Es,
    handlers: H,
  ): HandleAll<Es, ReturnOf<H[keyof Es]>> =>
  (k) =>
    Object.entries(effects as unknown as Record<string, Loose>).reduce(
      (acc, [n, e]) => e.handle(handlers[n])(acc),
      k as AnyKyoot,
    ) as never;

export type AnswerAll<Es extends Effects> = <B, S extends Row>(
  k: Kyoot<B, S>,
) => Kyoot<B, MergeAll<Omit<S, Es[keyof Es]["key"]>>>;

// Interceptors for some of a group's effects, keyed by name; the rest pass through untouched.
export type Interceptors<Es extends Effects> = {
  [N in keyof Es]?: Parameters<Es[N]["intercept"]>[0];
};

export const interceptAll =
  <const Es extends Effects, H extends Interceptors<Es>>(effects: Es, interceptors: H) =>
  <B, S extends Row>(
    k: Kyoot<B, S>,
  ): Kyoot<
    B,
    MergeAll<Omit<S, Es[keyof H & keyof Es]["key"]> | RowsOf<ReturnOf<NonNullable<H[keyof H]>>>>
  > =>
    Object.entries(effects as unknown as Record<string, Loose>).reduce(
      (acc, [n, e]) => (interceptors[n] ? e.intercept(interceptors[n])(acc) : acc),
      k as AnyKyoot,
    ) as never;

// handleAll for handlers that always resume at once with a value: each answers from its payload and
// the machine skips the mask and resumer (see answering). Unlike handleAll it does not check the row
// of the program, so a generic caller (Var.run) states its own bound.
export const answerAll =
  <const Es extends Effects>(
    effects: Es,
    answers: { [N in keyof Es]: (payload: PayloadIn<Es[N]>) => AnswerIn<Es[N]> },
  ): AnswerAll<Es> =>
  (k) =>
    Object.entries(effects as unknown as Record<string, Loose>).reduce(
      (acc, [n, e]) => (answering(e.key, answers[n] as (payload: unknown) => unknown) as Wrap)(acc),
      k as AnyKyoot,
    ) as never;

export const collect =
  <const K extends string>(key: K) =>
  <A, S extends Row & { [k in K]?: Op<unknown, void> }>(
    k: Kyoot<A, S>,
  ): Kyoot<readonly [A, Array<Payload<S, K>>], MergeAll<Omit<S, K>>> =>
    gen(function* () {
      const payloads: unknown[] = [];
      const a = yield* makeHandler(key, k, (payload, resume) => {
        payloads.push(payload);
        return resume(undefined);
      });
      return [a, payloads] as const;
    }) as never;

export const forEach =
  <const K extends string, P, R>(key: K, f: (payload: P) => R) =>
  <A, S extends Row & { [k in K]?: Op<P, void> }>(
    k: Kyoot<A, S>,
  ): Kyoot<A, MergeAll<Omit<S, K> | RowsOf<R>>> =>
    makeHandler(key, k, (payload, resume) => {
      const r = f(payload);
      return isKyoot(r) ? r.flatMap(() => resume(undefined)) : resume(undefined);
    }) as never;
