import { makeHandler, makeOp, succeed } from "../core.ts";
import type { Kyoot } from "../model.ts";
import type { Row } from "../types.ts";

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

export const run = <A, S extends Row & { resource?: unknown }>(k: Kyoot<A, S>) =>
  makeHandler({
    effectKey: "resource",
    self: k,
    state: [] as Finalizer[],
    onOp: (op: { acquire: () => unknown; release: (r: any) => void }, resume, finalizers) => {
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
