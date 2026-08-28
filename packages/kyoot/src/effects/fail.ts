import { InterruptedError, makeHandler, makeIntercept, op, succeed } from "../core.ts";
import type { AnyKyoot, Kyoot } from "../model.ts";
import { Result } from "../result.ts";
import type { FailRow, MergeAll, Row } from "../types.ts";

export const fail = <E>(e: E) => op<never>()("fail", e);

// See a failure on its way out — log it, map it — and `next` it on. The
// answer type is `never`, so `f` cannot recover; `catchAll` does that.
export const intercept = <E = unknown>() => makeIntercept<"fail", E, never>("fail");

export const run = <A, S extends Row & { fail?: unknown }>(k: Kyoot<A, S>) =>
  makeHandler("fail", k, {
    onOp: (e) => succeed(Result.fail(e)),
    onSuccess: (a) => succeed(Result.ok(a)),
    onDefect: (d) => succeed(Result.defect(d)),
  });

export const fromResult = <E, A = never>(r: Result<E, A>): Kyoot<A, FailRow<E>> => {
  if (r.ok) return succeed(r.value) as Kyoot<A, FailRow<E>>;
  switch (r.cause._tag) {
    case "Fail":
      return fail(r.cause.error) as Kyoot<A, FailRow<E>>;
    case "Interrupted":
      throw new InterruptedError();
    case "Defect":
      throw r.cause.defect;
  }
};

export const catchAll =
  <E, A2, S2 extends Row>(f: (e: E) => Kyoot<A2, S2>) =>
  <A, S extends Row & { fail?: E }>(k: Kyoot<A, S>) =>
    makeHandler("fail", k, { onOp: (e) => f(e) });

export const orThrow = <A, S extends Row & { fail?: unknown }>(k: Kyoot<A, S>) =>
  makeHandler("fail", k, {
    onOp: (e) => {
      throw e;
    },
  });

type Tagged = { readonly _tag: string };

type Refail<S extends Row, E> = Omit<S, "fail"> | FailRow<E>;

export const catchTag =
  <T extends string, E extends { _tag: T }, A2, S2 extends Row>(
    tag: T,
    f: (e: E) => Kyoot<A2, S2>,
  ) =>
  <A, S extends Row & { fail?: Tagged }>(
    k: Kyoot<A, S>,
  ): Kyoot<A | A2, MergeAll<Refail<S, Exclude<S["fail"], { _tag: T } | undefined>> | S2>> =>
    makeHandler("fail", k, {
      onOp: (e): AnyKyoot => (e._tag === tag ? f(e as unknown as E) : fail(e)),
    }) as never;

export const mapError = <E, E2>(f: (e: E) => E2) => catchAll((e: E) => fail(f(e)));
