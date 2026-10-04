import {
  gen,
  isKyoot,
  unsafeMakeHandler,
  makeIntercept,
  makeOp,
  type DependentRequirement,
  succeed,
} from "../core.ts";
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

declare const family: unique symbol;
export type ResourceRow<S extends Row = {}> = {
  resource: DependentRequirement<ResourceOp<S>, S, typeof family>;
};

export const acquire = <R, C>(open: () => R, close: (r: R) => C) =>
  makeOp("resource", { acquire: open, release: close }) as Kyoot<R, ResourceRow<RowOf<C>>>;

export const unsafeIntercept = <S extends Row = {}>() =>
  makeIntercept<"resource", ResourceOp<S>, unknown, {}, ResourceRow<S>["resource"]>("resource");

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

type ReleaseRow<R> =
  R extends DependentRequirement<ResourceOp<infer S>, any, typeof family> ? S : never;

export const run = <A, S extends Row & Partial<ResourceRow<any>>>(
  k: Kyoot<A, S>,
): Kyoot<A, MergeAll<Omit<S, "resource"> | ReleaseRow<S["resource"]>>> =>
  unsafeMakeHandler("resource", k, {
    fork: "scope",
    create: () => [] as Finalizer[],
    onOp: (res: ResourceOp, resume, finalizers) => {
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
