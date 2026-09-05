import {
  NodeSym,
  type AnyKyoot,
  type ForkMode,
  type HandlerHooks,
  type KnownOperationsOf,
  type Kyoot,
  type MergeOperations,
  type OnOp,
  type Operation,
  type RemoveOperations,
  type RowOf,
  type RowsOf,
  type RuntimeNode,
  type RuntimeResume,
  type Snapshot,
  type ValueOf,
} from "./model.ts";
import { pipeArguments, type Pipeable } from "./pipe.ts";
import type { CleanupFailure } from "./result.ts";
import type { Keys, MergeAll, Only, Remove, Row, Simplify } from "./types.ts";

class KyootIterator<A, S extends Row, Ops> implements Iterator<Kyoot<unknown, S, Ops>, A, unknown> {
  private used = false;
  done = false;
  value: unknown;

  constructor(k: Kyoot<unknown, S, Ops>) {
    this.value = k;
  }

  next(v?: unknown): IteratorResult<Kyoot<unknown, S, Ops>, A> {
    if (this.used) {
      this.done = true;
      this.value = v;
    } else {
      this.used = true;
    }
    return this as unknown as IteratorResult<Kyoot<unknown, S, Ops>, A>;
  }
}

// oxlint-disable-next-line no-unused-vars, typescript/no-unsafe-declaration-merging
export interface KyootImpl<A, S extends Row = {}, Ops = unknown> extends Pipeable {}
export class KyootImpl<A, S extends Row = {}, Ops = unknown> implements Kyoot<A, S, Ops> {
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
    return new KyootIterator<A, S, Ops>(this);
  }
}

export const isKyoot = (value: unknown): value is AnyKyoot => value instanceof KyootImpl;

export const succeed = <A>(value: A): Kyoot<A, {}, never> => new KyootImpl("pure", value);

/** Build a program lazily; the factory runs only when the program executes. */
export const defer = <A, S extends Row, Ops>(factory: () => Kyoot<A, S, Ops>): Kyoot<A, S, Ops> =>
  new KyootImpl("flatMap", succeed(undefined), factory) as Kyoot<A, S, Ops>;

export const makeOp = (key: PropertyKey, payload: unknown, handlers?: readonly Snapshot[]) =>
  new KyootImpl("op", key, payload, handlers);

export const genNode = (factory: () => Generator<AnyKyoot, unknown, unknown>): AnyKyoot =>
  new KyootImpl("gen", factory);

export const gen = <A, Y extends AnyKyoot>(
  f: () => Generator<Y, A, unknown>,
): Kyoot<A, MergeAll<RowsOf<Y>>, KnownOperationsOf<Y>> =>
  genNode(f as () => Generator<AnyKyoot, unknown, unknown>) as never;

export const op =
  <A>() =>
  <const K extends string, P>(key: K, payload: P): Kyoot<A, { [k in K]: P }, Operation<K, P, A>> =>
    makeOp(key, payload) as Kyoot<A, { [k in K]: P }, Operation<K, P, A>>;

export const fail = <E>(e: E) => op<never>()("fail", e);

export interface Resume<A, St, C extends Row = Row> {
  (value: A, state?: St): Kyoot<never, {}, never>;
  with<S extends Row & Partial<C>>(
    program: Kyoot<A, S> & Only<S, Keys<C>>,
    state?: St,
  ): Kyoot<never, {}, never>;
}

type Performed<K extends string, P, V, A, C extends Row> = Kyoot<
  A,
  Simplify<{ [k in K]: V } & C>,
  Operation<K, P, A, C>
>;

type IsAny<T> = 0 extends 1 & T ? true : false;
type OperationsAt<Ops, K extends PropertyKey> = Ops extends { readonly key: K } ? Ops : never;
type OperationCheck<Ops, K extends string, P, A, C extends Row> =
  IsAny<Ops> extends true
    ? unknown
    : Exclude<OperationsAt<Ops, K>, Operation<K, P, A, C>> extends never
      ? unknown
      : {
          readonly "operation signature mismatch": Exclude<
            OperationsAt<Ops, K>,
            Operation<K, P, A, C>
          >;
        };
export interface Cell<St> {
  readonly create: () => St;
  readonly fork?: ForkMode;
}

type Interceptor<K extends string, P, V, A, C extends Row, St, Ret> = (
  payload: P,
  next: (payload: P) => Performed<K, P, V, A, C>,
  state: St,
) => Ret;

type Interception<K extends string, P, V, A, C extends Row, Ret> = <
  B,
  S extends Row & { [k in K]?: V },
  Ops,
>(
  k: Kyoot<B, S, Ops> & OperationCheck<Ops, K, P, A, C>,
) => Kyoot<
  B,
  MergeAll<Remove<S, K> | RowOf<Ret>>,
  MergeOperations<RemoveOperations<Ops, K>, KnownOperationsOf<Ret>>
>;

export interface Intercept<K extends string, P, A, C extends Row = {}, V = P> {
  <Ret extends Kyoot<A, any>>(
    f: Interceptor<K, P, V, A, C, undefined, Ret>,
  ): Interception<K, P, V, A, C, Ret>;
  <St, Ret extends Kyoot<A, any>>(
    cell: Cell<St>,
    f: Interceptor<K, P, V, A, C, St, Ret>,
  ): Interception<K, P, V, A, C, Ret>;
}

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

type Nothing = Kyoot<never, {}, never>;

export const effect =
  <P, A, C extends Row = {}, V = P>() =>
  <const K extends string>(key: K) => {
    const perform = (payload: P) => makeOp(key, payload) as Performed<K, P, V, A, C>;
    const handle =
      <
        St = undefined,
        ROp extends AnyKyoot = Nothing,
        RDefect extends AnyKyoot = Nothing,
        RInterrupt extends void | AnyKyoot = void,
      >(
        hooks: Hooks<P, A, St, C, ROp, RDefect, RInterrupt>,
      ) =>
      <B, S extends Row & { [k in K]?: V }, Ops>(
        k: Kyoot<B, S, Ops> & OperationCheck<Ops, K, P, A, C>,
      ) =>
        makeHandler(key, k, hooks);
    return Object.assign(perform, { key, handle, intercept: makeIntercept<K, P, A, C, V>(key) });
  };

export type Payload<S, K extends PropertyKey> = S extends unknown
  ? K extends keyof S
    ? {} extends Pick<S, K>
      ? Exclude<S[K], undefined>
      : S[K]
    : never
  : never;

export function makeHandler<
  K extends PropertyKey,
  A,
  S extends Row,
  Ops,
  St = undefined,
  P = Payload<S, K>,
  C extends Row = Row,
  ROp extends AnyKyoot = Nothing,
  RSuccess extends AnyKyoot = Kyoot<A, {}, never>,
  RDefect extends AnyKyoot = Nothing,
  RInterrupt extends void | AnyKyoot = void,
>(
  effectKey: K,
  self: Kyoot<A, S, Ops>,
  hooks: Hooks<P, any, St, C, ROp, RDefect, RInterrupt> & {
    onSuccess?: (a: A, state: St) => RSuccess;
  },
): Kyoot<
  ValueOf<RSuccess> | ValueOf<ROp> | ValueOf<RDefect>,
  MergeAll<Remove<S, K> | RowOf<ROp> | RowOf<RSuccess> | RowOf<RDefect> | RowOf<RInterrupt>>,
  MergeOperations<
    RemoveOperations<Ops, K>,
    KnownOperationsOf<ROp | RSuccess | RDefect | RInterrupt>
  >
> {
  return new KyootImpl("handler", self, effectKey, hooks as unknown as HandlerHooks) as never;
}

export class InterruptedError extends Error {
  readonly _tag = "InterruptedError";
  cleanup: readonly CleanupFailure[] | undefined;
  constructor(message = "fiber interrupted") {
    super(message);
    this.name = "InterruptedError";
  }

  addCleanup(failures: readonly CleanupFailure[]): void {
    if (failures.length > 0) this.cleanup = [...(this.cleanup ?? []), ...failures];
  }
}

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
