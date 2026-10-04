import {
  gen,
  isKyoot,
  unsafeMakeHandler,
  makeIntercept,
  makeOp,
  type Requirement,
  type Payload,
  succeed,
} from "../core.ts";
import type { Kyoot, RowOf } from "../model.ts";
import { runFiber, type Served, type ServedRow } from "../runtime.ts";
import type { MergeAll, Only, Row } from "../types.ts";
import * as Async from "./async.ts";

export const value = <E>(e: E): Kyoot<void, { emit: Requirement<E, void> }> =>
  makeOp("emit", e) as Kyoot<void, { emit: Requirement<E, void> }>;

export const intercept = <E = unknown>() =>
  makeIntercept<"emit", E, void, {}, Requirement<E, void>>("emit");

export const fromIterable = <E>(items: Iterable<E>) =>
  gen(function* () {
    for (const e of items) yield* value(e);
  });

export const fromAsyncIterable = <E>(items: AsyncIterable<E>) =>
  gen(function* () {
    const it = items[Symbol.asyncIterator]();
    while (true) {
      const r = yield* Async.fromPromise(async (signal) => {
        const onAbort = () => void it.return?.();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          return await it.next();
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      });
      if (r.done) return;
      yield* value(r.value);
    }
  });

export const collect = <A, S extends Row & { emit?: Requirement<any, void> }>(k: Kyoot<A, S>) =>
  unsafeMakeHandler("emit", k, {
    create: () => [] as Array<Payload<S, "emit">>,
    onOp: (e: Payload<S, "emit">, resume, acc) => {
      acc.push(e);
      return resume(undefined);
    },
    onSuccess: (a, acc) => succeed([a, acc] as const),
  });

export const forEach =
  <E, R>(f: (e: E) => R) =>
  <A, S extends Row & { emit?: Requirement<any, void> }>(
    k: Kyoot<A, S> & ([Payload<S, "emit">] extends [E] ? unknown : never),
  ): Kyoot<A, MergeAll<Omit<S, "emit"> | RowOf<R>>> =>
    unsafeMakeHandler("emit", k, {
      onOp: (e: E, resume) => {
        const r = f(e);
        return isKyoot(r) ? r.flatMap(() => resume(undefined)) : resume(undefined);
      },
    }) as never;

export const map = <E, E2>(f: (e: E) => E2) => forEach((e: E) => value(f(e)));

export const discard = forEach(() => {});

export const toAsyncIterable = <
  S extends Row & Partial<ServedRow> & { emit?: Requirement<any, void> },
>(
  k: Kyoot<unknown, S> & Only<S, "emit" | Served>,
  options: { readonly buffer?: number } = {},
): AsyncIterable<Payload<S, "emit">> => ({
  [Symbol.asyncIterator]() {
    const capacity = Math.max(1, options.buffer ?? 16);
    const buffer: Payload<S, "emit">[] = [];
    let finished = false;
    let failed = false;
    let failure: unknown;
    let wake = () => {};
    let drain = () => {};
    const fiber = runFiber(
      k.pipe(
        forEach((e: Payload<S, "emit">) => {
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
