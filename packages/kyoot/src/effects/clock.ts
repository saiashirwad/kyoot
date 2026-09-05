import { effect, makeHandler, succeed } from "../core.ts";
import type { Kyoot } from "../model.ts";
import type { Row } from "../types.ts";

const clock = effect<number, void>()("clock");

export const sleep = (ms: number) => {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError("sleep delay must be finite and non-negative");
  }
  return clock(ms);
};

export const handle = clock.handle;

export const intercept = clock.intercept;

export const virtual = <A, S extends Row & { clock?: number }, Ops>(k: Kyoot<A, S, Ops>) =>
  makeHandler("clock", k, {
    initial: 0,
    onOp: (ms, resume, now) => resume(undefined, now + ms),
    onSuccess: (a, now) => succeed([a, now] as const),
  });
