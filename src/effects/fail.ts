import { KyootImpl, makeOp, succeed } from "../core.ts";
import type { AnyKyoot, Kyoot } from "../model.ts";
import { Result } from "../result.ts";
import type { Merge, Row, Simplify } from "../types.ts";

export const fail = <E>(e: E): Kyoot<never, { fail: E }> =>
  makeOp("fail", e) as Kyoot<never, { fail: E }>;

export const run = <A, S extends Row & { fail?: unknown } = {}>(
  k: Kyoot<A, S>,
): Kyoot<Result<S["fail"], A>, Simplify<Omit<S, "fail">>> =>
  new KyootImpl({
    _tag: "handler",
    effectKey: "fail",
    self: k as AnyKyoot,
    onOp: (e) => succeed(Result.fail(e)),
    onSuccess: (a) => succeed(Result.ok(a)),
    onDefect: (d) => succeed(Result.defect(d)),
  });

export const catchAll =
  <E, A2, S2 extends Row>(f: (e: E) => Kyoot<A2, S2>) =>
  <A, S extends Row & { fail?: E } = {}>(
    k: Kyoot<A, S>,
  ): Kyoot<A | A2, Merge<Omit<S, "fail">, S2>> =>
    new KyootImpl({
      _tag: "handler",
      effectKey: "fail",
      self: k as AnyKyoot,
      onOp: (e) => f(e) as AnyKyoot,
    });

export const orThrow = <A, S extends Row & { fail?: unknown } = {}>(
  self: Kyoot<A, S>,
): Kyoot<A, Simplify<Omit<S, "fail">>> =>
  new KyootImpl({
    _tag: "handler",
    effectKey: "fail",
    self,
    onOp: (e) => {
      throw e;
    },
  });
