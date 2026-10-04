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
    return this as unknown as RuntimeNode;
  }

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

export const makeOp = (key: PropertyKey, payload: unknown, handlers?: readonly Snapshot[]) =>
  new KyootImpl("op", key, payload, handlers);

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

export const fail = <E>(e: E): Kyoot<never, { fail: Requirement<E, never> }> =>
  new KyootImpl("op", "fail", e);

export interface Resume<A, St, C extends Row = Row> {
  (value: A, state?: St): Kyoot<never, {}>;
  with<S extends Row & Partial<C>>(
    program: Kyoot<A, S> & Only<S, keyof C>,
    state?: St,
  ): Kyoot<never, {}>;
}

declare const requirement: unique symbol;

interface RequirementShape<P, A, V, C extends Row, Keys extends PropertyKey> {
  readonly [requirement]: {
    readonly kind: "fixed";
    readonly payload: (value: P) => P;
    readonly value: (value: V) => V;
    readonly answer: (value: A) => A;
    readonly continuation: (row: C) => C;
    readonly continuationKeys: (key: Keys) => Keys;
  };
}

export type Requirement<P, A, V = P, C extends Row = {}> = RequirementShape<P, A, V, C, keyof C>;

export interface DependentRequirement<P, V, Family extends symbol> {
  readonly [requirement]: {
    readonly kind: "dependent";
    readonly family: Family;
    readonly payload: (value: P) => P;
    readonly value: (value: V) => V;
  };
}

type IsUnion<T, Whole = T> = T extends Whole ? ([Whole] extends [T] ? false : true) : never;
export type SingletonKey<K extends PropertyKey> = [K] extends [never]
  ? never
  : true extends IsUnion<K>
    ? never
    : {} extends Record<K, unknown>
      ? never
      : K;

export type KeyArgument<K extends PropertyKey> = [K] extends [never]
  ? never
  : [key: K & SingletonKey<K>];

export type EffectRow<K extends string, P, A, C extends Row = {}, V = P> = {
  [Q in K]: Requirement<P, A, V, C>;
};

type Performed<K extends string, V, A, C extends Row> = Kyoot<
  A,
  Simplify<{ [k in K]: V } & MergeAll<Required<C>>>
>;

export interface Cell<St> {
  readonly create: () => St;
  readonly fork?: ForkMode<St>;
}

type Interceptor<K extends string, P, V, A, C extends Row, St, Ret> = (
  payload: P,
  next: (payload: P) => Performed<K, V, A, C>,
  state: St,
) => Ret;

type Interception<K extends string, V, Ret> = <B, S extends Row & { [k in K]?: V }>(
  k: Kyoot<B, S>,
) => Kyoot<B, MergeAll<Omit<S, K> | RowOf<Ret>>>;

export interface Intercept<K extends string, P, A, C extends Row = {}, V = P> {
  <Ret extends Kyoot<A, any>>(
    f: Interceptor<K, P, V, A, C, undefined, Ret>,
  ): Interception<K, V, Ret>;
  <St, Ret extends Kyoot<A, any>>(
    cell: Cell<St>,
    f: Interceptor<K, P, V, A, C, St, Ret>,
  ): Interception<K, V, Ret>;
}

export const makeIntercept = <K extends string, P, A, C extends Row = {}, V = P>(
  key: K,
): Intercept<K, P, A, C, V> => {
  type F = Interceptor<K, P, V, A, C, any, AnyKyoot>;
  const deliver =
    key === "fail"
      ? (k: AnyKyoot) => k
      : (k: AnyKyoot, resume: RuntimeResume): AnyKyoot =>
          unsafeMakeHandler("fail", k, {
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
      unsafeMakeHandler(key, k, { create: cell?.create, fork: cell?.fork, onOp: onOp as never });
  };
};

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
  fork?: ForkMode<St>;
  onOp: (payload: P, resume: Resume<A, St, C>, state: St) => ROp;
  onDefect?: (d: unknown, state: St) => RDefect;
  onInterrupt?: (state: St) => RInterrupt;
}

type Nothing = Kyoot<never, {}>;

export const effect =
  <P, A, C extends Row = {}, V = P>() =>
  <const K extends string>(
    ...[checkedKey]: KeyArgument<K> & [key: K extends keyof MergeAll<C> ? never : K]
  ) => {
    const key: K = checkedKey;
    const perform = (payload: P) =>
      makeOp(key, payload) as Performed<K, Requirement<P, A, V, C>, A, C>;
    const handle =
      <
        St = undefined,
        ROp extends AnyKyoot = Nothing,
        RDefect extends AnyKyoot = Nothing,
        RInterrupt extends void | AnyKyoot = void,
      >(
        hooks: Hooks<P, A, St, C, ROp, RDefect, RInterrupt>,
      ) =>
      <B, S extends Row & { [k in K]?: Requirement<P, A, V, C> }>(k: Kyoot<B, S>) =>
        unsafeMakeHandler(key, k, hooks);
    const handler = <
      B,
      S extends Row & { [Q in K]?: Requirement<P, A, V, C> },
      St = undefined,
      ROp extends AnyKyoot = Nothing,
      RSuccess extends AnyKyoot = Kyoot<B, {}>,
      RDefect extends AnyKyoot = Nothing,
      RInterrupt extends void | AnyKyoot = void,
    >(
      k: Kyoot<B, S>,
      hooks: Hooks<P, A, St, C, ROp, RDefect, RInterrupt> & {
        onSuccess?: (a: B, state: St) => RSuccess;
      },
    ) => unsafeMakeHandler(key, k, hooks);
    return Object.assign(perform, {
      key,
      handle,
      handler,
      intercept: makeIntercept<K, P, A, C, Requirement<P, A, V, C>>(key),
    });
  };

type PayloadOf<T> = T extends {
  readonly [requirement]: { readonly payload: (value: infer P) => unknown };
}
  ? P
  : T;
type FixedRequirement = { readonly [requirement]: { readonly kind: "fixed" } };

type AnswerOf<T> = [T] extends [never]
  ? never
  : [T] extends [FixedRequirement]
    ? (
        T extends {
          readonly [requirement]: {
            readonly kind: "fixed";
            readonly answer: (value: infer A) => unknown;
          };
        }
          ? (answer: A) => void
          : never
      ) extends (answer: infer A) => void
      ? A
      : never
    : never;

export type Payload<S, K extends PropertyKey> = K extends keyof S ? PayloadOf<S[K]> : never;
export type Answer<S, K extends PropertyKey> = K extends keyof S ? AnswerOf<S[K]> : never;

export function unsafeMakeHandler<
  K extends PropertyKey,
  A,
  S extends Row,
  St = undefined,
  P = K extends keyof S ? Exclude<S[K], undefined> : never,
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
  return new KyootImpl("handler", self, effectKey, hooks as unknown as HandlerHooks) as never;
}

export function makeHandler<
  K extends PropertyKey,
  A,
  S extends Row,
  St = undefined,
  ROp extends AnyKyoot = Nothing,
  RSuccess extends AnyKyoot = Kyoot<A, {}>,
  RDefect extends AnyKyoot = Nothing,
  RInterrupt extends void | AnyKyoot = void,
>(
  effectKey: K & SingletonKey<K>,
  self: Kyoot<A, S> &
    (K extends keyof S ? ([S[K]] extends [FixedRequirement] ? unknown : never) : never),
  hooks: Hooks<
    Payload<NoInfer<S>, NoInfer<K>>,
    Answer<NoInfer<S>, NoInfer<K>>,
    St,
    {},
    ROp,
    RDefect,
    RInterrupt
  > & {
    onSuccess?: (a: A, state: St) => RSuccess;
  },
): Kyoot<
  ValueOf<RSuccess> | ValueOf<ROp> | ValueOf<RDefect>,
  MergeAll<Omit<S, K> | RowOf<ROp> | RowOf<RSuccess> | RowOf<RDefect> | RowOf<RInterrupt>>
> {
  return unsafeMakeHandler<K, A, S, St, Payload<S, K>, {}, ROp, RSuccess, RDefect, RInterrupt>(
    effectKey,
    self,
    hooks,
  );
}

export class InterruptedError extends Error {
  readonly _tag = "InterruptedError";
  constructor(message = "fiber interrupted") {
    super(message);
    this.name = "InterruptedError";
  }
}

export const inherit = (k: AnyKyoot, snapshots: readonly Snapshot[] = []): AnyKyoot => {
  for (const { node, state } of snapshots) {
    const hooks = node.c;
    const copied: HandlerHooks = {
      initial: typeof hooks.fork === "function" ? hooks.fork(state) : state,
      fork: hooks.fork,
      onOp: hooks.onOp,
    };
    k = unsafeMakeHandler(node.b, k, (hooks.fork === "scope" ? hooks : copied) as never);
  }
  return k;
};

KyootImpl.prototype.pipe = function (this: unknown, ...fns: Array<(x: any) => any>) {
  return pipeArguments(this, fns);
};
