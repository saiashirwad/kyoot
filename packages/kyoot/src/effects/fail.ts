import { catchDefect, makeHandler, makeIntercept, op, succeed, type Resume } from "../core.ts";
import type { AnyKyoot, Kyoot } from "../model.ts";
import { Result } from "../result.ts";
import type { FailRow, MergeAll, Op, Payload, Row } from "../types.ts";

export const fail = <E>(e: E) => op<never>()("fail", e);

export const intercept = <E = unknown>() => makeIntercept<"fail", E, never>("fail");

type FailHandled<A, S extends Row, B, S2 extends Row> = Kyoot<
  A | B,
  MergeAll<Omit<S, "fail"> | S2>
>;

const handleFail = <A, S extends Row, B, S2 extends Row>(
  k: Kyoot<A, S>,
  onFail: (e: any) => Kyoot<B, S2>,
) => makeHandler("fail", k, onFail, false) as FailHandled<A, S, B, S2>;

export const run = <A, S extends Row & { fail?: Op<unknown, never> }>(k: Kyoot<A, S>) =>
  catchDefect(
    handleFail(k.map(Result.ok), (e) => succeed(Result.fail(e))),
    (d) => succeed(Result.defect(d)),
  );

export const resumeOrFail = <A, E, S extends Row & { fail?: Op<E, never> }>(
  resume: Resume<A, { fail: Op<E, never> }>,
  program: Kyoot<A, S>,
) => program.pipe(catchAll((e: E) => resume.with(fail(e)))).flatMap((a) => resume(a));

export const fromResult = <E, A = never>(r: Result<E, A>): Kyoot<A, FailRow<E>> => {
  if (r.ok) return succeed(r.value);
  switch (r.cause._tag) {
    case "Fail":
      return fail(r.cause.error) as Kyoot<A, FailRow<E>>;
    case "Defect":
      throw r.cause.defect;
  }
};

export const catchAll =
  <E, A2, S2 extends Row>(f: (e: E) => Kyoot<A2, S2>) =>
  <A, S extends Row & { fail?: Op<E, never> }>(k: Kyoot<A, S>) =>
    handleFail(k, (e: E) => f(e));

export const orThrow = <A, S extends Row & { fail?: Op<unknown, never> }>(k: Kyoot<A, S>) =>
  handleFail(k, (e): Kyoot<never> => {
    throw e;
  });

type Tagged = { readonly _tag: string };

type Refail<S extends Row, E> = Omit<S, "fail"> | FailRow<E>;

export const catchTag =
  <T extends string, E extends { _tag: T }, A2, S2 extends Row>(
    tag: T,
    f: (e: E) => Kyoot<A2, S2>,
  ) =>
  <A, S extends Row & { fail?: Op<Tagged, never> }>(
    k: Kyoot<A, S>,
  ): Kyoot<A | A2, MergeAll<Refail<S, Exclude<Payload<S, "fail">, { _tag: T }>> | S2>> =>
    catchAll((e: Tagged): AnyKyoot => (e._tag === tag ? f(e as E) : fail(e)))(k) as never;

export const mapError = <E, E2>(f: (e: E) => E2) => catchAll((e: E) => fail(f(e)));
