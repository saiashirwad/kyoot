import { ensuring, gen, isKyoot, makeHandler, makeIntercept, op } from "../core.ts";
import type { AnyKyoot, Kyoot, RowsOf } from "../model.ts";
import { Result } from "./result.ts";
import type { MergeAll, Op, Payload, Row } from "../types.ts";
import * as Fail from "./fail.ts";

type Finalizer = () => unknown;

// The op carries the whole acquisition, so an interceptor sees each one and can wrap open (time it,
// retry it, log it). open's row is O (it stays in the caller's row); close's row is C (it lands in
// Resource.run's result).
export interface ResourceOp<O extends Row = {}, C extends Row = {}> {
  readonly _?: (c: C) => void;
  readonly open: Kyoot<unknown, O>;
  readonly close: (r: any) => unknown;
}

// Resource.run's handler runs open at the op site and registers close in the same step open
// completes: nothing (interrupt included) can run between the two, so a resource is never held
// without its close, and an open that fails, dies or is interrupted registers nothing.
export const acquire = <R, S extends Row, C>(
  open: Kyoot<R, S>,
  close: (r: R) => C,
): Kyoot<R, MergeAll<S | { resource: Op<ResourceOp<S, RowsOf<C>>, unknown> }>> =>
  op<unknown>()("resource", { open, close }) as never;

export const intercept = <O extends Row = {}, C extends Row = {}>() =>
  makeIntercept<"resource", ResourceOp<O, C>, unknown>("resource");

// Every release runs, newest first, whatever the earlier ones did; the first failure is reported
// after the last. A typed failure (Fail.run is how it is caught: a release that fails must not
// abort the releases below it) is reported only when the body finished normally; if the body failed
// or died, that outcome stands. A release defect is always reported, as ensuring does.
const finalize = (finalizers: readonly Finalizer[], completed: () => boolean) =>
  gen(function* () {
    let first: Result<unknown, unknown> | undefined;
    for (let i = finalizers.length - 1; i >= 0; i--) {
      let r: unknown;
      try {
        r = finalizers[i]!();
      } catch (defect) {
        first ??= Result.defect(defect);
        continue;
      }
      if (!isKyoot(r)) continue;
      const result = yield* Fail.run(r as AnyKyoot);
      if (!result.ok) first ??= result;
    }
    if (first !== undefined && !first.ok && (first.cause._tag === "Defect" || completed())) {
      yield* Fail.fromResult(first);
    }
  });

type ReleaseRow<R> = R extends ResourceOp<any, infer C> ? C : never;

export const run = <A, S extends Row & { resource?: Op<ResourceOp<any, any>, unknown> }>(
  k: Kyoot<A, S>,
): Kyoot<A, MergeAll<Omit<S, "resource"> | ReleaseRow<Payload<S, "resource">>>> =>
  gen(function* () {
    const finalizers: Finalizer[] = [];
    let completed = false;
    const scope = makeHandler("resource", k, (res: ResourceOp, resume) =>
      resume.with(
        res.open.map((r) => {
          finalizers.push(() => res.close(r));
          return r;
        }) as never,
      ),
    );
    return yield* ensuring(
      scope.map((a) => ((completed = true), a)),
      finalize(finalizers, () => completed),
    );
  }) as never;
