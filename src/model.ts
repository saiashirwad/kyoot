import type { Pipeable } from "./pipe.ts";
import type { Merge, Row } from "./types.ts";

export type AnyKyoot = Kyoot<any, any>;

export type Resume = (value: any, state?: any) => AnyKyoot;

export type OnOp = (payload: any, resume: Resume, state: any) => AnyKyoot;

export type Continuation = (v: any) => AnyKyoot;

export type RuntimeNode =
  | { readonly _tag: "pure"; readonly value: unknown }
  | {
      readonly _tag: "op";
      readonly effectKey: PropertyKey;
      readonly payload: unknown;
    }
  | { readonly _tag: "map"; readonly self: AnyKyoot; readonly mapper: (a: any) => any }
  | {
      readonly _tag: "handler";
      readonly effectKey: PropertyKey;
      readonly self: AnyKyoot;
      readonly state?: unknown;
      readonly onOp: OnOp;
      /** Defaults to pure success (`succeed(a)`). */
      readonly onSuccess?: (a: any, state: any) => AnyKyoot;
      readonly onDefect?: (d: unknown, state: any) => AnyKyoot;
      readonly onInterrupt?: (state: any) => void;
    }
  | { readonly _tag: "raise"; readonly error: unknown };

export const NodeSym: unique symbol = Symbol("kyoot.node");

export interface Kyoot<A, S extends Row = {}> extends Pipeable {
  readonly _?: (s: S) => void;

  /** Transform the value. `f` returns a plain value; a returned Kyoot is just a value. */
  map<B>(f: (a: A) => B): Kyoot<B, S>;

  /** Sequence a Kyoot after this one. Rows merge. (`S2 = {}` keeps a thrown `never` from widening to `Row`.) */
  flatMap<B, S2 extends Row = {}>(f: (a: A) => Kyoot<B, S2>): Kyoot<B, Merge<S, S2>>;

  [Symbol.iterator](): Iterator<Kyoot<unknown, S>, A, unknown>;
}

export type RowsOf<Y> = Y extends Kyoot<any, infer S> ? S : never;
