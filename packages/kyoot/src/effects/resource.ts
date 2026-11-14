import {
  catchDefect,
  ensuring,
  gen,
  isKyoot,
  makeHandler,
  makeIntercept,
  op,
  unit,
} from "../core.ts";
import type { Kyoot, RowsOf } from "../model.ts";
import type { MergeAll, Op, Payload, Row } from "../types.ts";

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

const finalize = (finalizers: readonly Finalizer[]) =>
  gen(function* () {
    let failed: { defect: unknown } | undefined;
    const record = (defect: unknown) => ((failed ??= { defect }), unit);
    for (let i = finalizers.length - 1; i >= 0; i--) {
      let r: unknown;
      try {
        r = finalizers[i]!();
      } catch (defect) {
        record(defect);
        continue;
      }
      if (isKyoot(r)) yield* catchDefect(r, record);
    }
    if (failed !== undefined) throw failed.defect;
  });

type ReleaseRow<R> = R extends ResourceOp<any, infer C> ? C : never;

export const run = <A, S extends Row & { resource?: Op<ResourceOp<any, any>, unknown> }>(
  k: Kyoot<A, S>,
): Kyoot<A, MergeAll<Omit<S, "resource"> | ReleaseRow<Payload<S, "resource">>>> =>
  gen(function* () {
    const finalizers: Finalizer[] = [];
    const scope = makeHandler("resource", k, (res: ResourceOp, resume) =>
      resume.with(
        res.open.map((r) => {
          finalizers.push(() => res.close(r));
          return r;
        }) as never,
      ),
    );
    return yield* ensuring(scope, finalize(finalizers));
  }) as never;
