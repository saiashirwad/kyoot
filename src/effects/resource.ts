import { makeHandler, op, succeed } from "../core.ts";
import type { Kyoot } from "../model.ts";
import type { Row } from "../types.ts";

type Finalizer = () => void;

export interface ResourceOp {
  readonly acquire: () => unknown;
  readonly release: (r: unknown) => void;
}

export const acquire = <R>(acquire: () => R, release: (r: R) => void) =>
  op<R>()("resource", { acquire, release } as ResourceOp);

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

export const run = <A, S extends Row & { resource?: ResourceOp }>(k: Kyoot<A, S>) =>
  makeHandler({
    effectKey: "resource",
    self: k,
    state: [] as Finalizer[],
    onOp: (res, resume, finalizers) => {
      const r = res.acquire();
      return resume(r, [...finalizers, () => res.release(r)]);
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
