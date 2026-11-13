import { effect, makeHandler, makeOp, withState, type Resume } from "../core.ts";
import type { Kyoot } from "../model.ts";
import type { AsyncRuntime } from "./runtime.ts";
import type { Op, Row } from "../types.ts";

const clock = effect<number, void>()("clock");

export const sleep = (ms: number) => clock(ms);

export const handle = clock.handle;

export const intercept = clock.intercept;

export const virtual = <A, S extends Row & { clock?: Op<number, void> }>(k: Kyoot<A, S>) =>
  makeHandler("clock", k, {
    initial: 0,
    onOp: (ms: number, resume: Resume<void, number>, now) => resume(undefined, now + ms),
    onReturn: withState,
  });

const realSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const onAbort = () => clearTimeout(t);
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

export const live = clock.handle({
  onOp: (ms, resume) =>
    resume.with(
      makeOp("async", { execute: (rt: AsyncRuntime) => realSleep(ms, rt.signal) }) as never,
    ),
});
