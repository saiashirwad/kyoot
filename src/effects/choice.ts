import { makeOp, succeed } from "../core.ts";
import { makeHandler } from "../handler.ts";
import type { AnyKyoot, Kyoot } from "../model.ts";
import type { Row, Simplify } from "../types.ts";

export function get<E>(options: readonly E[]): Kyoot<E, { choice: true }> {
  return makeOp("choice", options) as Kyoot<E, { choice: true }>;
}

export function run() {
  return <A, S extends Row & { choice: unknown }>(
    k: Kyoot<A, S>,
  ): Kyoot<A[], Simplify<Omit<S, "choice">>> =>
    makeHandler({
      effectKey: "choice",
      self: k as AnyKyoot,
      onOp: (options: readonly unknown[], resume) => {
        let branches: AnyKyoot = succeed([]);
        for (const option of options) {
          branches = branches.map((results: unknown[]) =>
            resume(option).map((sub: unknown[]) => [...results, ...sub]),
          );
        }
        return branches;
      },
      onSuccess: (a) => succeed([a]),
    }) as Kyoot<A[], Simplify<Omit<S, "choice">>>;
}
