import { makeHandler, makeOp, succeed } from "../core.ts";
import type { Kyoot } from "../model.ts";
import type { Row } from "../types.ts";

export function value<E>(e: E): Kyoot<void, { emit: E }> {
  return makeOp("emit", e) as Kyoot<void, { emit: E }>;
}

export const run = <A, S extends Row & { emit?: unknown }>(k: Kyoot<A, S>) =>
  makeHandler({
    effectKey: "emit",
    self: k,
    state: [] as Array<S["emit"]>,
    onOp: (e, resume, acc) => resume(undefined, [...acc, e]),
    onSuccess: (a, acc) => succeed([a, acc] as const),
  });

export const forEach =
  <E>(f: (e: E) => void) =>
  <A, S extends Row & { emit?: E }>(k: Kyoot<A, S>) =>
    makeHandler({
      effectKey: "emit",
      self: k,
      onOp: (e, resume) => {
        f(e);
        return resume(undefined);
      },
    });

export const discard = <A, S extends Row & { emit?: unknown }>(k: Kyoot<A, S>) =>
  makeHandler({ effectKey: "emit", self: k, onOp: (_e, resume) => resume(undefined) });
