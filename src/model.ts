import type { Pipeable } from "./pipe.ts";
import type { Merge, Row, Simplify } from "./types.ts";

export type AnyKyoot = Kyoot<any, any>;

// resume answers an op and continues the computation under the same
// handler. The second argument names the handler's next state; omit it to
// keep the current state. Continuations are multi-shot: a handler may call
// resume any number of times, and each call is an independent branch.
export type Resume = (value: any, state?: any) => AnyKyoot;

export type OnOp = (payload: any, resume: Resume, state: any) => AnyKyoot;

export type Continuation = (v: any) => AnyKyoot;

// The answers a generator has received so far, newest first. A fresh
// generator fed this trace rebuilds the suspension point — that replay is
// what makes continuations multi-shot. It requires generator bodies to be
// pure between yields: all effects must go through ops.
export type Trace = {
  readonly input: unknown;
  readonly prev: Trace | null;
};

// The live generator already positioned at this suspension point. The
// first resumption claims it and pays nothing; later resumptions find it
// gone and replay the trace instead.
export type GenCache = { live: Generator<AnyKyoot, any, unknown> | null };

export type RuntimeNode =
  | { readonly _tag: "pure"; readonly value: unknown }
  | {
      readonly _tag: "op";
      readonly effectKey: PropertyKey;
      readonly payload: unknown;
      readonly continuation: Continuation;
    }
  | { readonly _tag: "map"; readonly self: AnyKyoot; readonly mapper: (a: any) => any }
  | {
      readonly _tag: "handler";
      readonly effectKey: PropertyKey;
      readonly self: AnyKyoot;
      // Immutable — resume rebuilds the node with the next state, so the
      // branches of a multi-shot resumption never share state.
      readonly state: unknown;
      readonly onOp: OnOp;
      readonly onSuccess: (a: any, state: any) => AnyKyoot;
      readonly onDefect?: (d: unknown, state: any) => AnyKyoot;
    }
  | {
      readonly _tag: "gen";
      readonly factory: () => Generator<AnyKyoot, any, unknown>;
      readonly trace: Trace | null;
      readonly cache: GenCache;
    };

export const NodeSym: unique symbol = Symbol("kyoot.node");

export interface Kyoot<A, S extends Row = {}> extends Pipeable {
  readonly _?: (s: S) => void;

  readonly [NodeSym]: RuntimeNode;

  map<B, S2 extends Row = {}>(f: (a: A) => B | Kyoot<B, S2>): Kyoot<B, Simplify<Merge<S, S2>>>;

  [Symbol.iterator](): Iterator<Kyoot<unknown, S>, A, unknown>;
}

export type RowsOf<Y> = Y extends Kyoot<any, infer S> ? S : never;
