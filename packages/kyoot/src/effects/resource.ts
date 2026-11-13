import {
  catchDefect,
  ensuring,
  gen,
  isKyoot,
  makeHandler,
  makeIntercept,
  op,
  unit,
  type Resume,
} from "../core.ts";
import type { Kyoot, RowsOf } from "../model.ts";
import type { MergeAll, Op, Payload, Row } from "../types.ts";

type Finalizer = () => unknown;

export interface ResourceOp<S extends Row = {}> {
  readonly _?: (s: S) => void;
  readonly acquire: () => unknown;
  readonly release: (r: unknown) => unknown;
}

export const acquire = <R, C>(open: () => R, close: (r: R) => C) =>
  op<unknown>()("resource", { acquire: open, release: close }) as Kyoot<
    R,
    { resource: Op<ResourceOp<RowsOf<C>>, unknown> }
  >;

export const intercept = <S extends Row = {}>() =>
  makeIntercept<"resource", ResourceOp<S>, unknown>("resource");

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

export const run = <A, S extends Row & { resource?: Op<ResourceOp<any>, unknown> }>(
  k: Kyoot<A, S>,
): Kyoot<A, MergeAll<Omit<S, "resource"> | ReleaseRow<Payload<S, "resource">>>> =>
  gen(function* () {
    const finalizers: Finalizer[] = [];
    const scope = makeHandler("resource", k, {
      fork: run,
      onOp: (res: ResourceOp<any>, resume: Resume<unknown, undefined>) => {
        const r = res.acquire();
        finalizers.push(() => res.release(r));
        return resume(r);
      },
    });
    return yield* ensuring(scope, finalize(finalizers));
  }) as never;
