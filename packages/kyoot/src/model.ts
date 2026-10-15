import type { Pipeable } from "./pipe.ts";
import type { Merge, Row } from "./types.ts";

export type AnyKyoot = Kyoot<any, any>;

export type RuntimeResume = ((value: any, state?: any) => AnyKyoot) & {
  with: (program: AnyKyoot, state?: any) => AnyKyoot;
};

export type OnOp = (payload: any, resume: RuntimeResume, state: any, past: number) => AnyKyoot;

export type Fork = false | ((k: AnyKyoot) => AnyKyoot);

export interface HandlerHooks {
  readonly initial?: unknown;
  readonly create?: () => unknown;
  readonly fork?: Fork;
  readonly onOp?: OnOp;
  readonly tail?: (payload: any, state: any) => unknown;
  readonly onReturn?: (a: unknown, state: unknown) => AnyKyoot;
}

export interface Snapshot {
  readonly key: PropertyKey;
  readonly hooks: HandlerHooks;
  readonly state: unknown;
}

export interface Kyoot<A, S extends Row = {}> extends Pipeable {
  readonly _?: (s: S) => void;

  map<B>(f: (a: A) => B): Kyoot<B, S>;

  flatMap<B, S2 extends Row>(f: (a: A) => Kyoot<B, S2>): Kyoot<B, Merge<S, S2>>;

  [Symbol.iterator](): Iterator<Kyoot<unknown, S>, A, unknown>;
}

export type RowsOf<R> = R extends Kyoot<any, infer S> ? S : {};

export type ValueOf<R> = R extends Kyoot<infer A, any> ? A : never;
