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

/**
 * Result of `map`. Pure values (including `never` from `throw`) keep `S`.
 * Returning a nested Kyoot flattens and merges rows.
 *
 * Uses tuple checks so a free `S2 extends Row` is never introduced — that
 * unconstrained parameter used to collapse to `Row` and wipe real effect keys.
 */
export type MapResult<S extends Row, B> = [B] extends [never]
  ? Kyoot<never, S>
  : [B] extends [Kyoot<infer B2, infer S2>]
    ? Kyoot<B2, Merge<S, S2 extends Row ? S2 : {}>>
    : Kyoot<B, S>;

export interface Kyoot<A, S extends Row = {}> extends Pipeable {
  readonly _?: (s: S) => void;

  readonly [NodeSym]: RuntimeNode;

  map<B>(f: (a: A) => B): MapResult<S, B>;

  [Symbol.iterator](): Iterator<Kyoot<unknown, S>, A, unknown>;
}

export type RowsOf<Y> = Y extends Kyoot<any, infer S> ? S : never;
