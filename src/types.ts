export type Row = Record<string, unknown>;

export type Merge<S1 extends Row, S2 extends Row> = {
  [K in keyof S1 | keyof S2]:
    | (K extends keyof S1 ? S1[K] : never)
    | (K extends keyof S2 ? S2[K] : never);
};

export type Empty<S extends Row> = keyof S extends never ? unknown : never;

export type Unhandled<K> = { readonly "unhandled effects": K };

export type Only<S extends Row, Allow extends PropertyKey = never> =
  Exclude<keyof S, Allow> extends never ? unknown : Unhandled<Exclude<keyof S, Allow>>;

export type AsyncOnly<S extends Row> = keyof S extends "async" ? unknown : never;

export type Simplify<T> = { [K in keyof T]: T[K] } & {};

type AllKeys<U> = U extends unknown ? keyof U : never;

export type MergeAll<U> = [U] extends [never]
  ? {}
  : {
      [K in AllKeys<U>]: U extends unknown ? (K extends keyof U ? U[K] : never) : never;
    };
