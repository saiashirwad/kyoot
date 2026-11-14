import { gen, makeIntercept, makeOp, succeed } from "../core.ts";
import { value } from "../effects/emit.ts";
import { fail, type FailRow } from "../effects/fail.ts";
import type { Kyoot } from "../model.ts";
import type { MergeAll, Op } from "../types.ts";
import { InterruptedError } from "./runtime.ts";

// Promise interop: the boundary to real I/O. An "async" op carries a function that starts the work;
// the live driver calls it with the fiber's AbortSignal (aborted on interrupt) and resumes with the
// result. It is how live handlers (Node fs, fetch providers) do their work. A simulation cannot run
// it: there, declare an effect and answer it from the world instead.
export type AsyncOp = (signal: AbortSignal) => Promise<unknown>;

export type AsyncRow = { async: Op<AsyncOp, unknown> };

export const fromPromise = <A>(f: (signal: AbortSignal) => Promise<A>) =>
  makeOp("async", f) as Kyoot<A, AsyncRow>;

export const intercept = makeIntercept<"async", AsyncOp, unknown>("async");

export const never = fromPromise<never>(() => new Promise(() => {}));

export const tryPromise = <A, E>(
  f: (signal: AbortSignal) => Promise<A>,
  onError: (e: unknown) => E,
): Kyoot<A, MergeAll<AsyncRow | FailRow<E>>> =>
  fromPromise((signal) =>
    f(signal).then(
      (value) => ({ ok: true as const, value }),
      (e: unknown) => ({ ok: false as const, error: onError(e) }),
    ),
  ).flatMap((r) => (r.ok ? succeed(r.value) : fail(r.error))) as never;

export const next = <T>(it: AsyncIterator<T>) =>
  fromPromise(async (signal) => {
    const onAbort = () => void it.return?.();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await it.next();
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  });

const each = async <A>(
  values: ReadonlyArray<A>,
  signal: AbortSignal,
  step: (value: A, index: number) => Promise<void>,
) => {
  const count = values.length;
  for (let index = 0; index < count; index++) {
    if (signal.aborted) throw new InterruptedError();
    await step(values[index]!, index);
  }
};

export const mapPromise = <A, B>(
  values: ReadonlyArray<A>,
  f: (value: A, index: number, signal: AbortSignal) => Promise<B>,
): Kyoot<B[], AsyncRow> =>
  fromPromise(async (signal) => {
    const results: B[] = new Array(values.length);
    await each(values, signal, async (v, i) => {
      results[i] = await f(v, i, signal);
    });
    return results;
  });

export const forEachPromise = <A>(
  values: ReadonlyArray<A>,
  f: (value: A, index: number, signal: AbortSignal) => Promise<unknown>,
): Kyoot<void, AsyncRow> =>
  fromPromise((signal) =>
    each(values, signal, async (v, i) => {
      await f(v, i, signal);
    }),
  );

export const reducePromise = <A, B>(
  values: ReadonlyArray<A>,
  initial: B,
  f: (accumulator: B, value: A, index: number, signal: AbortSignal) => Promise<B>,
): Kyoot<B, AsyncRow> =>
  fromPromise(async (signal) => {
    let accumulator = initial;
    await each(values, signal, async (v, i) => {
      accumulator = await f(accumulator, v, i, signal);
    });
    return accumulator;
  });

export const fromAsyncIterable = <E>(items: AsyncIterable<E>) =>
  gen(function* () {
    const it = items[Symbol.asyncIterator]();
    while (true) {
      const r = yield* next(it);
      if (r.done) return;
      yield* value(r.value);
    }
  });
