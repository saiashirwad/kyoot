import { KyootImpl, makeOp, succeed } from "../core.ts";
import type { AnyKyoot, Kyoot } from "../model.ts";
import type { Row } from "../types.ts";

export function value<E>(e: E): Kyoot<void, { emit: E }> {
  return makeOp("emit", e) as Kyoot<void, { emit: E }>;
}

export function run() {
  return <A, S extends Row & { emit?: unknown } = {}>(k: Kyoot<A, S>) =>
    new KyootImpl({
      _tag: "handler",
      effectKey: "emit",
      self: k as AnyKyoot,
      state: [] as unknown[],
      onOp: (e, resume, acc) => resume(undefined, [...acc, e]),
      onSuccess: (a, acc) => succeed([a, acc]),
    });
}

export function forEach<E>(f: (e: E) => void) {
  return <A, S extends Row & { emit?: E } = {}>(k: Kyoot<A, S>) =>
    new KyootImpl({
      _tag: "handler",
      effectKey: "emit",
      self: k as AnyKyoot,
      onOp: (e, resume) => {
        f(e);
        return resume(undefined);
      },
      onSuccess: (a) => succeed(a),
    });
}

export function discard() {
  return <A, S extends Row & { emit?: unknown } = {}>(k: Kyoot<A, S>) =>
    new KyootImpl({
      _tag: "handler",
      effectKey: "emit",
      self: k as AnyKyoot,
      onOp: (_e, resume) => resume(undefined),
      onSuccess: (a) => succeed(a),
    });
}
