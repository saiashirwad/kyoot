import type { Kyoot } from './core.ts'

// The effect row: a record mapping effect key -> payload.
// Elimination is `Omit<S, K>` — removal by key, never by assignability.
export type Row = Record<string, unknown>

export type Merge<S1 extends Row, S2 extends Row> = {
  [K in keyof S1 | keyof S2]:
  | (K extends keyof S1 ? S1[K] : never)
  | (K extends keyof S2 ? S2[K] : never)
}

export type Empty<S extends Row> = keyof S extends never ? unknown : never

// A row containing at most the `async` slot.
export type AsyncOnly<S extends Row> = keyof S extends 'async' ? unknown : never

export type Simplify<T> = { [K in keyof T]: T[K] } & {}

// Extract the rows of a (possibly union) Kyo type, as a union of rows.
export type RowsOf<Y> = Y extends Kyoot<any, infer S> ? S : never

type AllKeys<U> = U extends unknown ? keyof U : never

// Collapse a union of rows into one canonical row: one slot per key,
// payloads unioned. Two `abort` sources land in one slot as `E1 | E2`.
export type MergeAll<U> = {
  [K in AllKeys<U>]: U extends unknown ? (K extends keyof U ? U[K] : never) : never
}

// The handler protocol, as settled in the design doc. Concrete handlers
// (Abort.run, Var.run, ...) use bespoke signatures because their `Out`
// shape depends on the program's `A` and on the payload in the handled slot.
export type Handler<K extends string, In, Out> = <A, S extends Row & { [P in K]: In }>(
  k: Kyoot<A, S>,
) => Kyoot<Out, Omit<S, K>>
