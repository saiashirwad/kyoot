import type { MergeAll, Row } from "./types.ts";

export type AnyKyoot = Kyoot<any, any>;

export type RuntimeResume = ((value: any) => AnyKyoot) & {
  with: (program: AnyKyoot) => AnyKyoot;
};

export type OnOp = (payload: any, resume: RuntimeResume, past: number) => AnyKyoot;

export interface HandlerHooks {
  readonly fork?: false | ((k: AnyKyoot) => AnyKyoot);
  readonly onOp: OnOp;
}

export interface Snapshot {
  readonly key: PropertyKey;
  readonly hooks: HandlerHooks;
}

interface Pipeable {
  pipe<A>(this: A): A;
  pipe<A, B>(this: A, ab: (a: A) => B): B;
  pipe<A, B, C>(this: A, ab: (a: A) => B, bc: (b: B) => C): C;
  pipe<A, B, C, D>(this: A, ab: (a: A) => B, bc: (b: B) => C, cd: (c: C) => D): D;
  pipe<A, B, C, D, E>(
    this: A,
    ab: (a: A) => B,
    bc: (b: B) => C,
    cd: (c: C) => D,
    de: (d: D) => E,
  ): E;
  pipe<A, B, C, D, E, F>(
    this: A,
    ab: (a: A) => B,
    bc: (b: B) => C,
    cd: (c: C) => D,
    de: (d: D) => E,
    ef: (e: E) => F,
  ): F;
  pipe<A, B, C, D, E, F, G>(
    this: A,
    ab: (a: A) => B,
    bc: (b: B) => C,
    cd: (c: C) => D,
    de: (d: D) => E,
    ef: (e: E) => F,
    fg: (f: F) => G,
  ): G;
  pipe<A, B, C, D, E, F, G, H>(
    this: A,
    ab: (a: A) => B,
    bc: (b: B) => C,
    cd: (c: C) => D,
    de: (d: D) => E,
    ef: (e: E) => F,
    fg: (f: F) => G,
    gh: (g: G) => H,
  ): H;
}

export interface Kyoot<A, S extends Row = {}> extends Pipeable {
  readonly _?: (s: S) => void;

  map<B>(f: (a: A) => B): Kyoot<B, S>;

  flatMap<B, S2 extends Row>(f: (a: A) => Kyoot<B, S2>): Kyoot<B, MergeAll<S | S2>>;

  [Symbol.iterator](): Iterator<Kyoot<unknown, S>, A, unknown>;
}

export type RowsOf<R> = R extends Kyoot<any, infer S> ? S : {};

export type ValueOf<R> = R extends Kyoot<infer A, any> ? A : never;
