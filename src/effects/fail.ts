import { DefectError, makeOp, succeed } from "../core.ts";
import { makeHandler } from "../handler.ts";
import type { AnyKyoot, Kyoot } from "../model.ts";
import { Result } from "../result.ts";
import type { Merge, Row, Simplify } from "../types.ts";

export function fail<E>(e: E): Kyoot<never, { fail: E }> {
  return makeOp("fail", e) as Kyoot<never, { fail: E }>;
}

export function run() {
  return <A, S extends Row & { fail: unknown }>(
    k: Kyoot<A, S>,
  ): Kyoot<Result<S["fail"], A>, Simplify<Omit<S, "fail">>> =>
    makeHandler({
      effectKey: "fail",
      self: k as AnyKyoot,
      onOp: (e) => succeed(Result.fail(e)),
      onSuccess: (a) => succeed(Result.ok(a)),
      onDefect: (d) => succeed(Result.defect(d)),
    }) as Kyoot<Result<S["fail"], A>, Simplify<Omit<S, "fail">>>;
}

export function catchAll<E, A2, S2 extends Row>(f: (e: E) => Kyoot<A2, S2>) {
  return <A, S extends Row & { fail: E }>(
    k: Kyoot<A, S>,
  ): Kyoot<A | A2, Simplify<Merge<Omit<S, "fail">, S2>>> =>
    makeHandler({
      effectKey: "fail",
      self: k as AnyKyoot,
      onOp: (e) => f(e) as AnyKyoot,
      onSuccess: (a) => succeed(a),
    }) as Kyoot<A | A2, Simplify<Merge<Omit<S, "fail">, S2>>>;
}

export function orThrow() {
  return <A, S extends Row & { fail: unknown }>(
    k: Kyoot<A, S>,
  ): Kyoot<A, Simplify<Omit<S, "fail">>> =>
    makeHandler({
      effectKey: "fail",
      self: k as AnyKyoot,
      onOp: (e) => {
        throw new DefectError(e);
      },
      onSuccess: (a) => succeed(a),
    }) as Kyoot<A, Simplify<Omit<S, "fail">>>;
}
