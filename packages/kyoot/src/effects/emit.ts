import { gen, isKyoot, makeHandler, makeIntercept, op, succeed } from "../core.ts";
import { unsafeRunFiber } from "../internal/run-fiber.ts";
import type {
  KnownOperationsOf,
  Kyoot,
  MergeOperations,
  RemoveOperations,
  RowOf,
} from "../model.ts";
import type { AsyncOp, Served } from "../runtime.ts";
import type { MergeAll, Only, Remove, Row } from "../types.ts";
import * as Async from "./async.ts";
import * as Resource from "./resource.ts";

export const value = <E>(e: E) => op<void>()("emit", e);

export const intercept = <E = unknown>() => makeIntercept<"emit", E, void>("emit");

export const fromIterable = <E>(items: Iterable<E>) =>
  gen(function* () {
    for (const e of items) yield* value(e);
  });

export const fromAsyncIterable = <E>(items: AsyncIterable<E>) =>
  Resource.acquire(
    () => ({
      iterator: items[Symbol.asyncIterator](),
      done: false,
      closing: undefined as Promise<void> | undefined,
    }),
    (state) =>
      Async.fromPromise(async () => {
        if (state.done) return;
        await (state.closing ??= Promise.resolve(state.iterator.return?.()).then(() => {}));
      }),
  )
    .flatMap((state) =>
      gen(function* () {
        while (true) {
          const r = yield* Async.fromPromise(() => state.iterator.next());
          if (r.done) {
            state.done = true;
            return;
          }
          yield* value(r.value);
        }
      }),
    )
    .pipe(Resource.run);

export const collect = <A, S extends Row & { emit?: unknown }, Ops>(k: Kyoot<A, S, Ops>) =>
  makeHandler("emit", k, {
    create: () => [] as Array<S["emit"]>,
    onOp: (e, resume, acc) => {
      acc.push(e);
      return resume(undefined);
    },
    onSuccess: (a, acc) => succeed([a, acc] as const),
  });

export const forEach =
  <E, R>(f: (e: E) => R) =>
  <A, S extends Row & { emit?: E }, Ops>(
    k: Kyoot<A, S, Ops>,
  ): Kyoot<
    A,
    MergeAll<Remove<S, "emit"> | (R extends PromiseLike<unknown> ? { async: AsyncOp } : RowOf<R>)>,
    MergeOperations<
      RemoveOperations<Ops, "emit">,
      R extends PromiseLike<unknown> ? never : KnownOperationsOf<R>
    >
  > =>
    makeHandler("emit", k, {
      onOp: (e, resume) => {
        const r = f(e as E);
        if (isKyoot(r)) return r.flatMap(() => resume(undefined));
        if (typeof (r as PromiseLike<unknown>)?.then === "function") {
          const promise = Promise.resolve(r as PromiseLike<unknown>);
          void promise.catch(() => {});
          return Async.fromPromise(() => promise).flatMap(() => resume(undefined));
        }
        return resume(undefined);
      },
    }) as never;

export const map = <E, E2>(f: (e: E) => E2) => forEach((e: E) => value(f(e)));

export const discard = forEach(() => {});

export const toAsyncIterable = <S extends Row & { emit?: unknown }>(
  k: Kyoot<unknown, S> & Only<S, "emit" | Served>,
  options: { readonly buffer?: number } = {},
): AsyncIterable<S["emit"]> => {
  const capacity = options.buffer ?? 16;
  if (!Number.isFinite(capacity) || !Number.isInteger(capacity) || capacity <= 0) {
    throw new RangeError("Emit.toAsyncIterable buffer must be a finite positive integer");
  }

  return {
    [Symbol.asyncIterator]() {
      const buffer: S["emit"][] = [];
      let finished = false;
      let failed = false;
      let failure: unknown;
      let closed = false;
      let closing: Promise<IteratorResult<S["emit"]>> | undefined;
      const readers: Array<{
        readonly resolve: (result: IteratorResult<S["emit"]>) => void;
        readonly reject: (reason: unknown) => void;
      }> = [];
      const admitted = Symbol("admitted");
      const producers: Array<{ value: S["emit"] | typeof admitted; readonly resolve: () => void }> =
        [];
      const done = (): IteratorResult<S["emit"]> => ({ value: undefined, done: true });

      const settle = () => {
        while (readers.length > 0 && buffer.length > 0) {
          readers.shift()!.resolve({ value: buffer.shift()!, done: false });
        }
        if (closed || finished) {
          while (readers.length > 0) {
            const reader = readers.shift()!;
            if (closed || !failed) reader.resolve(done());
            else reader.reject(failure);
          }
          while (producers.length > 0) producers.shift()!.resolve();
        }
        if (closed) {
          return;
        }
        while (buffer.length < capacity) {
          const pending = producers.find((producer) => producer.value !== admitted);
          if (pending !== undefined) {
            buffer.push(pending.value as S["emit"]);
            pending.value = admitted;
            continue;
          }
          const producer = producers.findIndex((producer) => producer.value === admitted);
          if (producer < 0) return;
          producers.splice(producer, 1)[0]!.resolve();
          void Promise.resolve().then(settle);
          return;
        }
      };

      const offer = (emitted: S["emit"]): Promise<void> | undefined => {
        if (closed) return;
        if (readers.length > 0) {
          readers.shift()!.resolve({ value: emitted, done: false });
          return;
        }
        if (buffer.length < capacity) {
          buffer.push(emitted);
          if (buffer.length < capacity) return;
          return new Promise<void>((resolve) => producers.push({ value: admitted, resolve }));
        }
        return new Promise<void>((resolve) => producers.push({ value: emitted, resolve }));
      };

      const fiber = unsafeRunFiber(
        k.pipe(
          forEach((e) => {
            const parked = offer(e);
            return parked === undefined
              ? undefined
              : Async.fromPromise(() => parked).flatMap(() => succeed(undefined));
          }),
        ),
      );
      fiber.promise.then(
        () => {
          finished = true;
          settle();
        },
        (e: unknown) => {
          failed = true;
          failure = e;
          finished = true;
          settle();
        },
      );
      return {
        async next() {
          if (closed) return done();
          if (buffer.length > 0) {
            const value = buffer.shift()!;
            settle();
            return { value, done: false };
          }
          if (failed) throw failure;
          if (finished) return done();
          return new Promise<IteratorResult<S["emit"]>>((resolve, reject) =>
            readers.push({ resolve, reject }),
          );
        },
        async return() {
          if (closing !== undefined) return closing;
          closed = true;
          buffer.length = 0;
          settle();
          closing = fiber.promise.then(
            () => done(),
            () => done(),
          );
          fiber.interrupt();
          return closing;
        },
      };
    },
  };
};
