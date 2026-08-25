import { isKyoot, makeHandler, op, succeed } from "../core.ts";
import { gen } from "../gen.ts";
import type { Kyoot, RowOf } from "../model.ts";
import { runFiber } from "../runtime.ts";
import type { MergeAll, Only, Row } from "../types.ts";
import * as Async from "./async.ts";

export const value = <E>(e: E) => op<void>()("emit", e);

export const fromIterable = <E>(items: Iterable<E>) =>
  gen(function* () {
    for (const e of items) yield* value(e);
  });

export const fromAsyncIterable = <E>(items: AsyncIterable<E>) =>
  gen(function* () {
    const it = items[Symbol.asyncIterator]();
    while (true) {
      const r = yield* Async.fromPromise((signal) => {
        signal.addEventListener("abort", () => void it.return?.(), { once: true });
        return it.next();
      });
      if (r.done) return;
      yield* value(r.value);
    }
  });

export const run = <A, S extends Row & { emit?: unknown }>(k: Kyoot<A, S>) =>
  makeHandler("emit", k, {
    initial: [] as Array<S["emit"]>,
    onOp: (e, resume, acc) => resume(undefined, [...acc, e]),
    onSuccess: (a, acc) => succeed([a, acc] as const),
  });

export const forEach =
  <E, R>(f: (e: E) => R) =>
  <A, S extends Row & { emit?: E }>(
    k: Kyoot<A, S>,
  ): Kyoot<A, MergeAll<Omit<S, "emit"> | RowOf<R>>> =>
    makeHandler("emit", k, {
      onOp: (e, resume) => {
        const r = f(e as E);
        return isKyoot(r) ? r.map(() => resume(undefined)) : resume(undefined);
      },
    }) as never;

export const map =
  <E, E2>(f: (e: E) => E2) =>
  <A, S extends Row & { emit?: E }>(k: Kyoot<A, S>) =>
    makeHandler("emit", k, {
      onOp: (e, resume) => value(f(e as E)).map(() => resume(undefined)),
    });

export const discard = <A, S extends Row & { emit?: unknown }>(k: Kyoot<A, S>) =>
  makeHandler("emit", k, { onOp: (_e, resume) => resume(undefined) });

export const toAsyncIterable = <S extends Row & { emit?: unknown }>(
  k: Kyoot<unknown, S> & Only<S, "emit" | "async" | "clock">,
): AsyncIterable<S["emit"]> => ({
  [Symbol.asyncIterator]() {
    const buffer: S["emit"][] = [];
    let finished = false;
    let failure: unknown;
    let wake = () => {};
    const fiber = runFiber(k.pipe(forEach((e: S["emit"]) => void (buffer.push(e), wake()))));
    fiber.promise.then(
      () => ((finished = true), wake()),
      (e: unknown) => ((failure = e), (finished = true), wake()),
    );
    return {
      async next() {
        while (buffer.length === 0 && !finished) await new Promise<void>((r) => (wake = r));
        if (buffer.length > 0) return { value: buffer.shift()!, done: false };
        if (failure !== undefined) throw failure;
        return { value: undefined, done: true };
      },
      async return() {
        fiber.interrupt();
        await fiber.promise.catch(() => {});
        return { value: undefined, done: true };
      },
    };
  },
});
