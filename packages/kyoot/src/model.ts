import type { Pipeable } from "./pipe.ts";
import type { Merge, Row } from "./types.ts";

export type AnyKyoot = Kyoot<any, any>;

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
  readonly onInterrupt?: (state: unknown) => void | AnyKyoot;
}

export type HandlerNode = Extract<RuntimeNode, { _tag: "handler" }>;

export interface Snapshot {
  readonly node: HandlerNode;
  readonly state: unknown;
}

export const NodeSym: unique symbol = Symbol("kyoot.node");

export interface Kyoot<A, S extends Row = {}> extends Pipeable {
  readonly _?: (s: S) => void;

  readonly [NodeSym]: RuntimeNode;

  map<B>(f: (a: A) => B): Kyoot<B, S>;

  flatMap<B, S2 extends Row>(f: (a: A) => Kyoot<B, S2>): Kyoot<B, Merge<S, S2>>;

  [Symbol.iterator](): Iterator<Kyoot<unknown, S>, A, unknown>;
}

export type RowsOf<Y> = Y extends Kyoot<any, infer S> ? S : never;

export type RowOf<R> = R extends Kyoot<any, infer S> ? S : {};

export type ValueOf<R> = R extends Kyoot<infer A, any> ? A : never;
