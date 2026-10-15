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
import type { Kyoot, RowOf } from "../model.ts";
import type { MergeAll, Row } from "../types.ts";

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

// Runs every finalizer, last acquired first, whatever the others do; the first defect
// among them is raised once they all have run.
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

// A forked fiber gets a scope of its own, released when the fiber ends.
export const run = <A, S extends Row & { resource?: ResourceOp<any> }>(
  k: Kyoot<A, S>,
): Kyoot<A, MergeAll<Omit<S, "resource"> | ReleaseRow<S["resource"]>>> =>
  gen(function* () {
    const finalizers: Finalizer[] = [];
    const scope = makeHandler("resource", k, {
      fork: run,
      onOp: (res, resume) => {
        const r = res.acquire();
        finalizers.push(() => res.release(r));
        return resume(r);
      },
    });
    return yield* ensuring(scope, finalize(finalizers));
  }) as never;
