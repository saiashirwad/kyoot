import { ensuring, gen, isKyoot, makeHandler, makeIntercept, op, type Resume } from "../core.ts";
import type { AnyKyoot, Kyoot, RowsOf } from "../model.ts";
import { Result } from "../result.ts";
import type { MergeAll, Op, Payload, Row } from "../types.ts";
import * as Fail from "./fail.ts";

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
    // A typed release failure reports only when the body finished; otherwise the body's outcome stands.
    if (first !== undefined && !first.ok && (first.cause._tag === "Defect" || completed())) {
      yield* Fail.fromResult(first);
    }
  });

type ReleaseRow<R> = R extends ResourceOp<infer S> ? S : never;

export const run = <A, S extends Row & { resource?: Op<ResourceOp<any>, unknown> }>(
  k: Kyoot<A, S>,
): Kyoot<A, MergeAll<Omit<S, "resource"> | ReleaseRow<Payload<S, "resource">>>> =>
  gen(function* () {
    const finalizers: Finalizer[] = [];
    let done = false;
    const scope = makeHandler("resource", k, {
      fork: run,
      onOp: (res: ResourceOp<any>, resume: Resume<unknown, undefined>) => {
        const r = res.acquire();
        finalizers.push(() => res.release(r));
        return resume(r);
      },
    });
    return yield* ensuring(
      scope.map((a) => ((done = true), a)),
      finalize(finalizers, () => done),
    );
  }) as never;
