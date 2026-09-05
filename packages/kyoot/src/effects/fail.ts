import {
  fail,
  InterruptedError,
  makeHandler,
  makeIntercept,
  succeed,
  type Payload,
} from "../core.ts";
import type { Kyoot, MergeOperations, Operation, RemoveOperations } from "../model.ts";
import { Result, type DefectCause, type Err } from "../result.ts";
import type { FailRow, MergeAll, Remove, Row } from "../types.ts";

export { fail };

export const intercept = <E = unknown>() => makeIntercept<"fail", E, never>("fail");

export const run = <A, S extends Row, Ops>(k: Kyoot<A, S, Ops>) =>
  makeHandler("fail", k, {
    onOp: (e) => succeed(Result.fail(e)),
    onSuccess: (a) => succeed(Result.ok(a)),
    onDefect: (d) => succeed(Result.fromDefect(d) as Err<DefectCause>),
  });

export const fromResult = <E, A = never>(r: Result<E, A>): Kyoot<A, FailRow<E>> => {
  if (r.ok) return succeed(r.value) as unknown as Kyoot<A, FailRow<E>>;
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
  <E, A2, S2 extends Row, Ops2>(f: (e: E) => Kyoot<A2, S2, Ops2>) =>
  <A, S extends Row, Ops>(
    k: Kyoot<A, S, Ops> &
      ([FailureOf<S>] extends [never]
        ? unknown
        : [FailureOf<S>] extends [E]
          ? unknown
          : { readonly "catchAll callback cannot accept": Exclude<FailureOf<S>, E> }),
  ) =>
    makeHandler("fail", k, { onOp: (e) => f(e as E) });

export const orThrow = <A, S extends Row, Ops>(k: Kyoot<A, S, Ops>) =>
  makeHandler("fail", k, {
    onOp: (e) => {
      throw e;
    },
  });

type Tagged<T extends string> = { readonly _tag: T };

type FailureOf<S> = Payload<S, "fail">;
type TaggedFailure<S, T extends string> = Extract<FailureOf<S>, Tagged<T>>;
type CatchTagCheck<S, T extends string, E> = [TaggedFailure<S, T>] extends [never]
  ? unknown
  : [TaggedFailure<S, T>] extends [E]
    ? unknown
    : {
        readonly "catchTag callback cannot accept": Exclude<TaggedFailure<S, T>, E>;
      };
type RemainingFailure<S, T extends string> = Exclude<FailureOf<S>, Tagged<T>>;
type Refail<S, E> = Remove<S, "fail"> | FailRow<E>;
type RefailOperation<E> = [E] extends [never] ? never : Operation<"fail", E, never>;

const hasTag = <T extends string>(error: unknown, tag: T): error is Tagged<T> =>
  ((typeof error === "object" && error !== null) || typeof error === "function") &&
  "_tag" in error &&
  error._tag === tag;

export const catchTag =
  <T extends string, E extends Tagged<T>, A2, S2 extends Row, Ops2>(
    tag: T,
    f: (e: E) => Kyoot<A2, S2, Ops2>,
  ) =>
  <A, S extends Row, Ops>(
    k: Kyoot<A, S, Ops> & CatchTagCheck<S, T, E>,
  ): Kyoot<
    A | A2,
    MergeAll<Refail<S, RemainingFailure<S, T>> | S2>,
    MergeOperations<
      RemoveOperations<Ops, "fail">,
      MergeOperations<Ops2, RefailOperation<RemainingFailure<S, T>>>
    >
  > =>
    makeHandler("fail", k as Kyoot<A, S, Ops>, {
      onOp: (error) => (hasTag(error, tag) ? f(error as E) : fail(error)),
    }) as never;

export const mapError = <E, E2>(f: (e: E) => E2) => catchAll((e: E) => fail(f(e)));
