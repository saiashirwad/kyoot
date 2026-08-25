import { makeHandler, makeOp, succeed } from "../core.ts";
import type { Kyoot } from "../model.ts";
import { Result } from "../result.ts";
import type { Row } from "../types.ts";

export const fail = <E>(e: E): Kyoot<never, { fail: E }> =>
  makeOp("fail", e) as Kyoot<never, { fail: E }>;

export const run = <A, S extends Row & { fail?: unknown }>(k: Kyoot<A, S>) =>
  makeHandler({
    effectKey: "fail",
    self: k,
    onOp: (e) => succeed(Result.fail(e)),
    onSuccess: (a) => succeed(Result.ok(a)),
    onDefect: (d) => succeed(Result.defect(d)),
  });

export const catchAll =
  <E, A2, S2 extends Row>(f: (e: E) => Kyoot<A2, S2>) =>
  <A, S extends Row & { fail?: E }>(k: Kyoot<A, S>) =>
    makeHandler({ effectKey: "fail", self: k, onOp: (e) => f(e) });

export const orThrow = <A, S extends Row & { fail?: unknown }>(k: Kyoot<A, S>) =>
  makeHandler({
    effectKey: "fail",
    self: k,
    onOp: (e) => {
      throw e;
    },
  });
