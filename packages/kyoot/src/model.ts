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
  inherited?: readonly HandlerNode[],
) => AnyKyoot;

// What a handler does at a fork. `copy`: the fiber gets `onOp` with the
// frame's state; the frame's end hooks stay with the parent. `scope`: the
// fiber gets a frame of its own, state from `create`, with the end hooks at
// the fiber's end. `none`: the handler stops at the fiber.
export type ForkMode = "copy" | "scope" | "none";

export type RuntimeNode =
  | { readonly _tag: "pure"; readonly value: unknown }
  | {
      readonly _tag: "op";
      readonly effectKey: PropertyKey;
      readonly payload: unknown;
      // Present on an op that collects the frames it crosses (see makeOp).
      readonly handlers?: readonly HandlerNode[];
    }
  | { readonly _tag: "map"; readonly self: AnyKyoot; readonly mapper: (a: any) => any }
  | { readonly _tag: "flatMap"; readonly self: AnyKyoot; readonly mapper: (a: any) => AnyKyoot }
  | { readonly _tag: "gen"; readonly factory: () => Generator<AnyKyoot, unknown, unknown> }
  // A handler's continuation, resumed: the machine restores what it holds.
  | { readonly _tag: "resume"; state: unknown }
  | {
      readonly _tag: "handler";
      readonly effectKey: PropertyKey;
      readonly self: AnyKyoot;
      readonly state?: unknown;
      readonly create?: () => unknown;
      readonly entered?: boolean;
      readonly fork?: ForkMode;
      readonly onOp: OnOp;
      readonly onSuccess?: (a: any, state: any) => AnyKyoot;
      readonly onDefect?: (d: unknown, state: any) => AnyKyoot;
      readonly onInterrupt?: (state: any) => void | AnyKyoot;
    }
  | { readonly _tag: "raise"; readonly error: unknown };

export type HandlerNode = Extract<RuntimeNode, { _tag: "handler" }>;

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
