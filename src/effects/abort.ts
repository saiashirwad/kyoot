import { DefectError, makeOp, succeed } from "../core.ts";
import { makeHandler } from "../handler.ts";
import type { AnyKyoot, Kyoot } from "../model.ts";
import { Result } from "../result.ts";
import type { Merge, Row, Simplify } from "../types.ts";

// Abort — typed failure. An ordinary effect with the same standing as any
// user-defined effect; `abort` is just a key in the row.

export function fail<E>(e: E): Kyoot<never, { abort: E }> {
  return makeOp("abort", e) as Kyoot<never, { abort: E }>;
}

// Eliminate `abort` into a Result. Typed failures land in the Fail channel;
// defects thrown inside the region land in the Defect channel.
export function run() {
  return <A, S extends Row & { abort: unknown }>(
    k: Kyoot<A, S>,
  ): Kyoot<Result<S["abort"], A>, Simplify<Omit<S, "abort">>> =>
    makeHandler({
      effectKey: "abort",
      self: k as AnyKyoot,
      onOp: (e) => succeed(Result.fail(e)),
      onSuccess: (a) => succeed(Result.ok(a)),
      onDefect: (d) => succeed(Result.defect(d)),
    }) as Kyoot<Result<S["abort"], A>, Simplify<Omit<S, "abort">>>;
}

// Replace a typed failure with a new computation, like Effect's catchAll.
// Defects bypass catchAll and surface at the edge.
export function catchAll<E, A2, S2 extends Row>(f: (e: E) => Kyoot<A2, S2>) {
  return <A, S extends Row & { abort: E }>(
    k: Kyoot<A, S>,
  ): Kyoot<A | A2, Simplify<Merge<Omit<S, "abort">, S2>>> =>
    makeHandler({
      effectKey: "abort",
      self: k as AnyKyoot,
      onOp: (e) => f(e) as AnyKyoot,
      onSuccess: (a) => succeed(a),
    }) as Kyoot<A | A2, Simplify<Merge<Omit<S, "abort">, S2>>>;
}

// Eliminate `abort` by throwing the error value if one occurs.
export function orThrow() {
  return <A, S extends Row & { abort: unknown }>(
    k: Kyoot<A, S>,
  ): Kyoot<A, Simplify<Omit<S, "abort">>> =>
    makeHandler({
      effectKey: "abort",
      self: k as AnyKyoot,
      onOp: (e) => {
        throw new DefectError(e);
      },
      onSuccess: (a) => succeed(a),
    }) as Kyoot<A, Simplify<Omit<S, "abort">>>;
}
