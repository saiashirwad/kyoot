import { collect as collecting, forEach as eaching, gen, makeIntercept, op } from "../core.ts";
import type { Kyoot } from "../model.ts";
import { runFiber, type Served } from "../runtime.ts";
import type { Only, Row } from "../types.ts";
import * as Async from "./async.ts";

export const value = <E>(e: E) => op<void>()("emit", e);

export const intercept = <E = unknown>() => makeIntercept<"emit", E, void>("emit");

export const fromIterable = <E>(items: Iterable<E>) =>
  gen(function* () {
    for (const e of items) yield* value(e);
  });

export const fromAsyncIterable = <E>(items: AsyncIterable<E>) =>
  gen(function* () {
    const it = items[Symbol.asyncIterator]();
    while (true) {
      const r = yield* Async.next(it);
      if (r.done) return;
      yield* value(r.value);
    }
  });

export const collect = collecting("emit");

export const forEach = <E, R>(f: (e: E) => R) => eaching("emit", f);

export const map = <E, E2>(f: (e: E) => E2) => forEach((e: E) => value(f(e)));

export const discard = forEach(() => {});

export const toAsyncIterable = <S extends Row & { emit?: unknown }>(
  k: Kyoot<unknown, S> & Only<S, "emit" | Served>,
  options: { readonly buffer?: number } = {},
): AsyncIterable<S["emit"]> => ({
  [Symbol.asyncIterator]() {
    const capacity = Math.max(1, options.buffer ?? 16);
    const buffer: S["emit"][] = [];
    let finished = false;
    let failed = false;
    let failure: unknown;
    let wake = () => {};
    let drain = () => {};
    const fiber = runFiber(
      k.pipe(
        forEach((e) => {
          buffer.push(e);
          if (buffer.length < capacity) {
            wake();
            return;
          }
          const parked = new Promise<void>((r) => (drain = r));
          wake();
          return Async.fromPromise(() => parked);
        }),
      ),
    );
    fiber.promise.then(
      () => ((finished = true), wake()),
      (e: unknown) => ((failed = true), (failure = e), (finished = true), wake()),
    );
    return {
      async next() {
        while (buffer.length === 0 && !finished) await new Promise<void>((r) => (wake = r));
        if (buffer.length > 0) {
          const value = buffer.shift()!;
          drain();
          return { value, done: false };
        }
        if (failed) throw failure;
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
