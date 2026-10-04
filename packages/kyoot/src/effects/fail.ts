import {
  fail,
  InterruptedError,
  unsafeMakeHandler,
  makeIntercept,
  succeed,
  type Requirement,
  type Payload,
} from "../core.ts";
import type { AnyKyoot, Kyoot } from "../model.ts";
import { Result } from "../result.ts";
import type { FailRow, MergeAll, Row } from "../types.ts";

export { fail };

export const intercept = <E = unknown>() =>
  makeIntercept<"fail", E, never, {}, Requirement<E, never>>("fail");

export const run = <A, S extends Row & { fail?: Requirement<any, never> }>(k: Kyoot<A, S>) =>
  unsafeMakeHandler("fail", k, {
    onOp: (e: Payload<S, "fail">) => succeed(Result.fail(e)),
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
  <A, S extends Row & { fail?: Requirement<any, never> }>(
    k: Kyoot<A, S> & ([Payload<S, "fail">] extends [E] ? unknown : never),
  ) =>
    unsafeMakeHandler("fail", k, { onOp: (e: E) => f(e) });

export const orThrow = <A, S extends Row & { fail?: Requirement<any, never> }>(k: Kyoot<A, S>) =>
  unsafeMakeHandler("fail", k, {
    onOp: (e: Payload<S, "fail">) => {
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
  <A, S extends Row & { fail?: Requirement<any, never> }>(
    k: Kyoot<A, S> &
      ([Payload<S, "fail">] extends [Tagged] ? unknown : never) &
      ([Extract<Payload<S, "fail">, { _tag: T }>] extends [E] ? unknown : never),
  ): Kyoot<
    A | A2,
    MergeAll<Refail<S, Exclude<Payload<S, "fail">, { _tag: T } | undefined>> | S2>
  > =>
    catchAll((e: Tagged): AnyKyoot => (e._tag === tag ? f(e as E) : fail(e)))(k) as never;

export const mapError = <E, E2>(f: (e: E) => E2) => catchAll((e: E) => fail(f(e)));
