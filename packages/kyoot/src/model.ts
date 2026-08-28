import type { Pipeable } from "./pipe.ts";
import type { Merge, Row } from "./types.ts";

export type AnyKyoot = Kyoot<any, any>;

export type OnOp = (
  payload: any,
  resume: ((value: any, state?: any) => AnyKyoot) & {
    with: (program: AnyKyoot, state?: any) => AnyKyoot;
  },
  state: any,
  // For an op that collects frames: the ones it crossed before this one,
  // innermost first.
  inherited?: readonly Snapshot[],
) => AnyKyoot;

// What a handler does at a fork. `copy`: the fiber gets `onOp` with the
// frame's state; the frame's end hooks stay with the parent. `scope`: the
// fiber gets a frame of its own, state from `create`, with the end hooks at
// the fiber's end. `none`: the handler stops at the fiber.
export type ForkMode = "copy" | "scope" | "none";

export type RuntimeNode =
  | { readonly _tag: "pure"; readonly a: unknown; readonly b: undefined; readonly c: undefined }
  | {
      readonly _tag: "op";
      readonly a: PropertyKey;
      readonly b: unknown;
      // Present on an op that collects the frames it crosses (see makeOp).
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
  // A handler's continuation: reached as a node, the machine puts back the
  // frames the handler holds and continues with what it resumed.
  | { readonly _tag: "resume"; readonly a: unknown; readonly b: undefined; readonly c: undefined }
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

// A handler frame as an op crossed it: the handler and its state then. A
// fiber the op spawns is built from these (see `inherit`).
export interface Snapshot {
  readonly node: HandlerNode;
  readonly state: unknown;
}

export const NodeSym: unique symbol = Symbol("kyoot.node");

export interface Kyoot<A, S extends Row = {}> extends Pipeable {
  readonly _?: (s: S) => void;

  readonly [NodeSym]: RuntimeNode;

  // `map` never runs a program its callback returns; that is `flatMap`.
  map<B>(f: (a: A) => B): Kyoot<B, S>;

  flatMap<B, S2 extends Row = {}>(f: (a: A) => Kyoot<B, S2>): Kyoot<B, Merge<S, S2>>;

  [Symbol.iterator](): Iterator<Kyoot<unknown, S>, A, unknown>;
}

export type RowsOf<Y> = Y extends Kyoot<any, infer S> ? S : never;

// The row of a callback's result: a program's row, or nothing for a plain value.
export type RowOf<R> = R extends Kyoot<any, infer S> ? (S extends Row ? S : {}) : {};

// The value a program returns; `never` for anything that is not a program.
export type ValueOf<R> = R extends Kyoot<infer A, any> ? A : never;
