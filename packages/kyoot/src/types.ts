export type Row = Record<string, unknown>;

export type Merge<S1 extends Row, S2 extends Row> = MergeAll<S1 | S2>;

export type FailRow<E> = [E] extends [never] ? {} : { fail: E };

export type Unhandled<K> = { readonly "unhandled effects": K };

export type Only<S extends Row, Allow extends PropertyKey = never> =
  Exclude<Keys<S>, Allow> extends never ? unknown : Unhandled<Exclude<Keys<S>, Allow>>;

export type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type Keys<U> = U extends unknown ? keyof U : never;

export type Remove<S, K extends PropertyKey> = S extends unknown ? Omit<S, K> : never;

export type MergeAll<U> = [U] extends [never]
  ? {}
  : {
      [K in Keys<U>]: U extends unknown ? (K extends keyof U ? U[K] : never) : never;
    };
