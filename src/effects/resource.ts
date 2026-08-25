import { KyootImpl, makeOp, succeed } from "../core.ts";
import type { AnyKyoot, Kyoot } from "../model.ts";
import type { Row, Simplify } from "../types.ts";

type Finalizer = () => void;

export const acquire = <R>(
  acquire: () => R,
  release: (r: R) => void,
): Kyoot<R, { resource: true }> =>
  makeOp("resource", { acquire, release }) as Kyoot<R, { resource: true }>;

const runFinalizers = (finalizers: readonly Finalizer[]): void => {
  let first: unknown;
  for (let i = finalizers.length - 1; i >= 0; i--) {
    try {
      finalizers[i]!();
    } catch (e) {
      if (first === undefined) first = e;
    }
  }
  if (first !== undefined) throw first;
};

export const run =
  () =>
  <A, S extends Row & { resource?: unknown } = {}>(
    k: Kyoot<A, S>,
  ): Kyoot<A, Simplify<Omit<S, "resource">>> =>
    new KyootImpl({
      _tag: "handler",
      effectKey: "resource",
      self: k as AnyKyoot,
      state: [] as Finalizer[],
      onOp: (
        op: { acquire: () => unknown; release: (r: any) => void },
        resume,
        finalizers: Finalizer[],
      ) => {
        const r = op.acquire();
        return resume(r, [...finalizers, () => op.release(r)]);
      },
      onSuccess: (a, finalizers) => {
        runFinalizers(finalizers);
        return succeed(a);
      },
      onDefect: (d, finalizers) => {
        try {
          runFinalizers(finalizers);
        } catch {
          /* prefer the original defect over a finalizer failure */
        }
        throw d;
      },
      onInterrupt: runFinalizers,
    });
