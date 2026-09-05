import type { Pipeable } from "./pipe.ts";
import type { Merge, Row } from "./types.ts";

declare const OperationVariance: unique symbol;
declare const Operations: unique symbol;
declare const RowValues: unique symbol;

export interface Operation<K extends PropertyKey, P, A, C extends Row = {}> {
  readonly key: K;
  readonly payload: P;
  readonly answer: A;
  readonly contract: C;
  readonly [OperationVariance]: (payload: P, answer: A, contract: C) => readonly [P, A, C];
}

export type AnyKyoot = Kyoot<any, any, any>;

export type RuntimeResume = ((value: any, state?: any) => AnyKyoot) & {
  with: (program: AnyKyoot, state?: any) => AnyKyoot;
};

export type OnOp = (
  payload: any,
  resume: RuntimeResume,
  state: any,
  inherited?: readonly Snapshot[],
) => AnyKyoot;

export type ForkMode = "copy" | "scope" | "none";

export type RuntimeNode =
  | {
      readonly _tag: "pure";
      readonly a: unknown;
      readonly b: undefined;
      readonly c: undefined;
    }
  | {
      readonly _tag: "op";
      readonly a: PropertyKey;
      readonly b: unknown;
      readonly c: readonly Snapshot[] | undefined;
    }
  | {
      readonly _tag: "map";
      readonly a: AnyKyoot;
      readonly b: (a: unknown) => unknown;
      readonly c: undefined;
    }
  | {
      readonly _tag: "flatMap";
      readonly a: AnyKyoot;
      readonly b: (a: unknown) => AnyKyoot;
      readonly c: undefined;
    }
  | {
      readonly _tag: "gen";
      readonly a: () => Generator<AnyKyoot, unknown, unknown>;
      readonly b: undefined;
      readonly c: undefined;
    }
  | {
      readonly _tag: "resume";
      readonly a: unknown;
      readonly b: number;
      readonly c: undefined;
    }
  | {
      readonly _tag: "handler";
      readonly a: AnyKyoot;
      readonly b: PropertyKey;
      readonly c: HandlerHooks;
    };

export interface HandlerHooks {
  readonly initial?: unknown;
  readonly create?: () => unknown;
  readonly fork?: ForkMode;
  readonly onOp: OnOp;
  readonly onSuccess?: (a: unknown, state: unknown) => AnyKyoot;
  readonly onDefect?: (d: unknown, state: unknown) => AnyKyoot;
  readonly onInterrupt?: (state: unknown, cause?: unknown) => void | AnyKyoot;
  readonly interruptMask?: boolean;
  readonly recoverInterrupt?: boolean;
}

export type HandlerNode = Extract<RuntimeNode, { _tag: "handler" }>;

export interface Snapshot {
  readonly node: HandlerNode;
  readonly state: unknown;
}

export const NodeSym: unique symbol = Symbol("kyoot.node");

// Two-argument annotations carry no signature evidence. Unknown must not swallow
// known operations introduced by later composition.
export interface Kyoot<A, S extends Row = {}, Ops = unknown> extends Pipeable {
  readonly _?: (row: S) => void;

  readonly [RowValues]?: NoInfer<Partial<S>>;

  readonly [Operations]?: () => Ops;

  readonly [NodeSym]: RuntimeNode;

  map<B>(f: (a: A) => B): Kyoot<B, S, Ops>;

  flatMap<R extends AnyKyoot>(
    f: (a: A) => R,
  ): Kyoot<ValueOf<R>, Merge<S, RowsOf<R>>, MergeOperations<Ops, KnownOperationsOf<R>>>;

  [Symbol.iterator](): Iterator<Kyoot<unknown, S, Ops>, A, unknown>;
}

export type RowsOf<Y> = Y extends Kyoot<any, infer S, any> ? S : never;

export type RowOf<R> = R extends Kyoot<any, infer S, any> ? S : {};

export type ValueOf<R> = R extends Kyoot<infer A, any, any> ? A : never;

type IsAny<T> = 0 extends 1 & T ? true : false;
type IsUnknown<T> =
  IsAny<T> extends true
    ? false
    : unknown extends T
      ? [keyof T] extends [never]
        ? true
        : false
      : false;

export type KnownOperationsOf<R> =
  R extends Kyoot<any, any, infer Ops>
    ? IsAny<Ops> extends true
      ? never
      : IsUnknown<Ops> extends true
        ? never
        : Ops
    : never;

export type MergeOperations<Ops1, Ops2> =
  IsAny<Ops1> extends true
    ? Ops2
    : IsAny<Ops2> extends true
      ? Ops1
      : IsUnknown<Ops1> extends true
        ? Ops2
        : IsUnknown<Ops2> extends true
          ? Ops1
          : Ops1 | Ops2;

export type RemoveOperations<Ops, K extends PropertyKey> = Ops extends {
  readonly key: infer OpKey;
}
  ? OpKey extends K
    ? never
    : Ops
  : Ops;
