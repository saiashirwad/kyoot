import { KyootImpl, makeOp, succeed } from "../core.ts";
import type { AnyKyoot, Kyoot } from "../model.ts";
import type { Row, Simplify } from "../types.ts";

export function value<E>(e: E): Kyoot<void, { emit: E }> {
  return makeOp("emit", e) as Kyoot<void, { emit: E }>;
}

export const run = <A, S extends Row & { emit?: unknown } = {}>(
  k: Kyoot<A, S>,
): Kyoot<[A, Array<S["emit"]>], Simplify<Omit<S, "emit">>> =>
  new KyootImpl({
    _tag: "handler",
    effectKey: "emit",
    self: k as AnyKyoot,
    state: [] as Array<S["emit"]>,
    onOp: (e, resume, acc) => resume(undefined, [...acc, e]),
    onSuccess: (a, acc) => succeed([a, acc]),
  });

export function forEach<E>(f: (e: E) => void) {
  return <A, S extends Row & { emit?: E } = {}>(
    k: Kyoot<A, S>,
  ): Kyoot<A, Simplify<Omit<S, "emit">>> =>
    new KyootImpl({
      _tag: "handler",
      effectKey: "emit",
      self: k as AnyKyoot,
      onOp: (e, resume) => {
        f(e);
        return resume(undefined);
      },
    });
}

export const discard = <A, S extends Row & { emit?: unknown } = {}>(
  k: Kyoot<A, S>,
): Kyoot<A, Simplify<Omit<S, "emit">>> =>
  new KyootImpl({
    _tag: "handler",
    effectKey: "emit",
    self: k as AnyKyoot,
    onOp: (_e, resume) => resume(undefined),
  });
