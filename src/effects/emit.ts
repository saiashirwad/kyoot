import { opKyoot, pureKyoot, type AnyKyoot, type Kyoot } from "../core.ts";
import { makeHandler } from "../handler.ts";
import type { Row, Simplify } from "../types.ts";

// Emit — streaming values out of a computation.

export function value<E>(e: E): Kyoot<void, { emit: E }> {
  return opKyoot("emit", e) as Kyoot<void, { emit: E }>;
}

// Collect everything emitted: [A, emitted[]].
export function run() {
  return <A, S extends Row & { emit: unknown }>(
    k: Kyoot<A, S>,
  ): Kyoot<[A, S["emit"][]], Simplify<Omit<S, "emit">>> => {
    const acc: unknown[] = [];
    return makeHandler({
      key: "emit",
      self: k as AnyKyoot,
      onOp: (e, resume) => {
        acc.push(e);
        return resume(undefined);
      },
      onPure: (a) => pureKyoot([a, acc]),
    }) as Kyoot<[A, S["emit"][]], Simplify<Omit<S, "emit">>>;
  };
}

// Consume values as they happen.
export function forEach<E>(f: (e: E) => void) {
  return <A, S extends Row & { emit: E }>(k: Kyoot<A, S>): Kyoot<A, Simplify<Omit<S, "emit">>> =>
    makeHandler({
      key: "emit",
      self: k as AnyKyoot,
      onOp: (e, resume) => {
        f(e as E);
        return resume(undefined);
      },
      onPure: (a) => pureKyoot(a),
    }) as Kyoot<A, Simplify<Omit<S, "emit">>>;
}

export function discard() {
  return <A, S extends Row & { emit: unknown }>(
    k: Kyoot<A, S>,
  ): Kyoot<A, Simplify<Omit<S, "emit">>> =>
    makeHandler({
      key: "emit",
      self: k as AnyKyoot,
      onOp: (_e, resume) => resume(undefined),
      onPure: (a) => pureKyoot(a),
    }) as Kyoot<A, Simplify<Omit<S, "emit">>>;
}
