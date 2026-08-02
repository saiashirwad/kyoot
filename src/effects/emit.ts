import { makeOp, succeed } from "../core.ts";
import { makeHandler } from "../handler.ts";
import type { AnyKyoot, Kyoot } from "../model.ts";
import type { Row, Simplify } from "../types.ts";

export function value<E>(e: E): Kyoot<void, { emit: E }> {
  return makeOp("emit", e) as Kyoot<void, { emit: E }>;
}

export function run() {
  return <A, S extends Row & { emit: unknown }>(
    k: Kyoot<A, S>,
  ): Kyoot<[A, S["emit"][]], Simplify<Omit<S, "emit">>> =>
    makeHandler<unknown[]>({
      effectKey: "emit",
      self: k as AnyKyoot,
      state: [],
      onOp: (e, resume, acc) => resume(undefined, [...acc, e]),
      onSuccess: (a, acc) => succeed([a, acc]),
    }) as Kyoot<[A, S["emit"][]], Simplify<Omit<S, "emit">>>;
}

export function forEach<E>(f: (e: E) => void) {
  return <A, S extends Row & { emit: E }>(k: Kyoot<A, S>): Kyoot<A, Simplify<Omit<S, "emit">>> =>
    makeHandler({
      effectKey: "emit",
      self: k as AnyKyoot,
      onOp: (e, resume) => {
        f(e as E);
        return resume(undefined);
      },
      onSuccess: (a) => succeed(a),
    }) as Kyoot<A, Simplify<Omit<S, "emit">>>;
}

export function discard() {
  return <A, S extends Row & { emit: unknown }>(
    k: Kyoot<A, S>,
  ): Kyoot<A, Simplify<Omit<S, "emit">>> =>
    makeHandler({
      effectKey: "emit",
      self: k as AnyKyoot,
      onOp: (_e, resume) => resume(undefined),
      onSuccess: (a) => succeed(a),
    }) as Kyoot<A, Simplify<Omit<S, "emit">>>;
}
