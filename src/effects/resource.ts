import { DefectError, invoke, makeOp, succeed } from "../core.ts";
import { makeHandler } from "../handler.ts";
import type { AnyKyoot, Kyoot } from "../model.ts";
import type { Row, Simplify } from "../types.ts";

type Finalizer = () => void;

export function acquire<R>(
  acquire: () => R,
  release: (r: R) => void,
): Kyoot<R, { resource: true }> {
  return makeOp("resource", { acquire, release }) as Kyoot<R, { resource: true }>;
}

const runFinalizers = (finalizers: readonly Finalizer[]): void => {
  let first: unknown;
  for (let i = finalizers.length - 1; i >= 0; i--) {
    try {
      invoke(finalizers[i]!);
    } catch (e) {
      if (first === undefined) first = e;
    }
  }
  if (first !== undefined) throw first;
};

export function run() {
  return <A, S extends Row & { resource: unknown }>(
    k: Kyoot<A, S>,
  ): Kyoot<A, Simplify<Omit<S, "resource">>> =>
    makeHandler<Finalizer[]>({
      effectKey: "resource",
      self: k as AnyKyoot,
      state: [],
      onOp: (op: { acquire: () => unknown; release: (r: any) => void }, resume, finalizers) => {
        const r = invoke(op.acquire);
        return resume(r, [...finalizers, () => op.release(r)]);
      },
      onSuccess: (a, finalizers) => {
        runFinalizers(finalizers);
        return succeed(a);
      },
      onDefect: (d, finalizers) => {
        try {
          runFinalizers(finalizers);
        } catch {}
        throw new DefectError(d);
      },
      onInterrupt: runFinalizers,
    }) as Kyoot<A, Simplify<Omit<S, "resource">>>;
}
