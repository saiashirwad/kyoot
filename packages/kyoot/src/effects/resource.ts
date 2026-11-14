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

export interface ResourceOp<S extends Row = {}> {
  readonly _?: (s: S) => void;
  readonly release: () => unknown;
}

// open is a program: its effects run in the caller's row, and its value is the resource. The scope
// learns of the resource only once open has finished, in the very next step: nothing (interrupt
// included) can run between the two, so a resource is never held without its close, and an open that
// fails, dies or is interrupted registers nothing.
export const acquire = <R, S extends Row, C>(
  open: Kyoot<R, S>,
  close: (r: R) => C,
): Kyoot<R, MergeAll<S | { resource: Op<ResourceOp<RowsOf<C>>, void> }>> =>
  gen(function* () {
    const r = yield* open;
    yield* op<void>()("resource", { release: () => close(r) });
    return r;
  }) as never;

export const intercept = <S extends Row = {}>() =>
  makeIntercept<"resource", ResourceOp<S>, void>("resource");

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

type ReleaseRow<R> = R extends ResourceOp<infer S> ? S : never;

export const run = <A, S extends Row & { resource?: Op<ResourceOp<any>, void> }>(
  k: Kyoot<A, S>,
): Kyoot<A, MergeAll<Omit<S, "resource"> | ReleaseRow<Payload<S, "resource">>>> =>
  gen(function* () {
    const finalizers: Finalizer[] = [];
    const scope = makeHandler("resource", k, (res: ResourceOp, resume) => {
      finalizers.push(res.release);
      return resume(undefined);
    });
    return yield* ensuring(scope, finalize(finalizers));
  }) as never;
