import type { Pipeable } from "./pipe.ts";
import type { Merge, Row, Simplify } from "./types.ts";

export type AnyKyoot = Kyoot<any, any>;

export type OnOp = (payload: any, resume: (v: any) => AnyKyoot) => AnyKyoot;

export type Node =
  | { readonly _tag: "pure"; readonly value: unknown }
  | {
      readonly _tag: "op";
      readonly key: string;
      readonly payload: unknown;
      readonly kont: (v: any) => AnyKyoot;
    }
  | { readonly _tag: "map"; readonly self: AnyKyoot; readonly f: (a: any) => any }
  | {
      readonly _tag: "handler";
      readonly key: string;
      readonly self: AnyKyoot;
      readonly onOp: OnOp;
      readonly onPure: (a: any) => AnyKyoot;
      readonly onDefect?: (d: unknown) => AnyKyoot;
    }
  | { readonly _tag: "gen"; readonly f: () => Generator<AnyKyoot, any, unknown> }
  | {
      readonly _tag: "gencont";
      readonly it: Generator<AnyKyoot, any, unknown>;
      readonly input: unknown;
    };

export const nodeSym: unique symbol = Symbol("kyoot.node");

export interface Kyoot<A, S extends Row = {}> extends Pipeable {
  readonly _?: (s: S) => void;

  readonly [nodeSym]: Node;

  map<B, S2 extends Row = {}>(f: (a: A) => B | Kyoot<B, S2>): Kyoot<B, Simplify<Merge<S, S2>>>;

  [Symbol.iterator](): Iterator<Kyoot<unknown, S>, A, unknown>;
}

export type RowsOf<Y> = Y extends Kyoot<any, infer S> ? S : never;
