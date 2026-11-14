export interface Op<out P, in A> {
  readonly payload: P;
  readonly resume: (answer: A) => void;
}

export type Row = Record<string, Op<unknown, never>>;

type At<U, K extends PropertyKey> = U extends unknown
  ? K extends keyof U
    ? NonNullable<U[K]>
    : never
  : never;

type PayloadOf<O> = O extends Op<infer P, never> ? P : never;

type AnswerOf<O> = [O] extends [never] ? never : [O] extends [Op<unknown, infer A>] ? A : never;

export type Payload<S, K extends PropertyKey> = PayloadOf<At<S, K>>;

export type Answer<S, K extends PropertyKey> = AnswerOf<At<S, K>>;

type Plain<K> = Exclude<K, `fork/${string}`>;

// A marker whose plain key is gone: a plain handler removed an effect a forked fiber still needs.
type ForkOnly<K, All = K> = K extends `fork/${infer X}` ? (X extends All ? never : X) : never;

type Unhandled<K> = [ForkOnly<K>] extends [never]
  ? { readonly "unhandled effects": Plain<K> }
  : {
      readonly "unhandled effects": Plain<K>;
      readonly "a forked fiber still needs these (a plain handler doesn't cross a fork): install them with Async.provide(handler)": ForkOnly<K>;
    };

export type Only<S extends Row, Allow extends PropertyKey = never> =
  Exclude<keyof S, Allow> extends never ? unknown : Unhandled<Exclude<keyof S, Allow>>;

export type Simplify<T> = { [K in keyof T]: T[K] } & {};

type AllKeys<U> = U extends unknown ? keyof U : never;

export type MergeAll<U extends Row> = [U] extends [never]
  ? {}
  : {
      [K in AllKeys<U>]: Op<Payload<U, K>, Answer<U, K>>;
    };
