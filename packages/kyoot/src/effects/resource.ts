import { gen, isKyoot, makeHandler, makeIntercept, op, succeed } from "../core.ts";
import type { Kyoot, RowOf } from "../model.ts";
import type { MergeAll, Row } from "../types.ts";
import type { Result } from "../result.ts";
import * as Fail from "./fail.ts";

type Finalizer = () => unknown;

export interface ResourceOp<S extends Row = {}> {
  readonly _?: (s: S) => void;
  readonly acquire: () => unknown;
  readonly release: (r: unknown) => unknown;
}

export const acquire = <R, C>(open: () => R, close: (r: R) => C) =>
  op<R>()("resource", { acquire: open, release: close } as ResourceOp<RowOf<C>>);

export const intercept = <S extends Row = {}>() =>
  makeIntercept<"resource", ResourceOp<S>, unknown>("resource");

const unit = succeed(undefined);

const attempt = (f: Finalizer) =>
  unit
    .flatMap(() => {
      const r = f();
      return isKyoot(r) ? r : succeed(r);
    })
    .pipe(Fail.run);

const finalize = (finalizers: readonly Finalizer[]) =>
  gen(function* () {
    const errors: Result<unknown, unknown>[] = [];
    for (let i = finalizers.length - 1; i >= 0; i--) {
      const result = yield* attempt(finalizers[i]!);
      if (!result.ok) errors.push(result);
    }
    return errors;
  });

type ReleaseRow<R> = R extends ResourceOp<infer S> ? S : never;

export const run = <A, S extends Row & { resource?: ResourceOp<any> }>(
  k: Kyoot<A, S>,
): Kyoot<A, MergeAll<Omit<S, "resource"> | ReleaseRow<S["resource"]>>> =>
  makeHandler("resource", k, {
    fork: "scope",
    create: () => [] as Finalizer[],
    onOp: (res, resume, finalizers) => {
      const r = res.acquire();
      finalizers.push(() => res.release(r));
      return resume(r);
    },
    onSuccess: (a, finalizers) =>
      finalize(finalizers).flatMap((errors) =>
        errors.length > 0 ? Fail.fromResult(errors[0]!) : succeed(a),
      ),
    onDefect: (d, finalizers) =>
      finalize(finalizers).map(() => {
        throw d;
      }),
    onInterrupt: (finalizers) => finalize(finalizers),
  }) as never;
