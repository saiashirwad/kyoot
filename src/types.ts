// The effect row: a record mapping effect key -> payload.
// Elimination is `Omit<S, K>` — removal by key, never by assignability.
export type Row = Record<string, unknown>;

export type Merge<S1 extends Row, S2 extends Row> = {
  [K in keyof S1 | keyof S2]:
    | (K extends keyof S1 ? S1[K] : never)
    | (K extends keyof S2 ? S2[K] : never);
};

export type Empty<S extends Row> = keyof S extends never ? unknown : never;

// A row containing at most the `async` slot.
export type AsyncOnly<S extends Row> = keyof S extends "async" ? unknown : never;

export type Simplify<T> = { [K in keyof T]: T[K] } & {};

type AllKeys<U> = U extends unknown ? keyof U : never;

// Collapse a union of rows into one canonical row: one slot per key,
// payloads unioned. Two `abort` sources land in one slot as `E1 | E2`.
export type MergeAll<U> = {
  [K in AllKeys<U>]: U extends unknown ? (K extends keyof U ? U[K] : never) : never;
};
