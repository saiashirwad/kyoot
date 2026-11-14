import { gen, makeHandler, makeIntercept, makeOp, succeed } from "../core.ts";
import { forEach, value } from "../effects/emit.ts";
import { fail, fromResult, Result, type Err, type FailRow } from "../effects/fail.ts";
import type { AnyKyoot, Kyoot } from "../model.ts";
import type { MergeAll, Only, Op, Payload, Row } from "../types.ts";
import { live, sleep } from "./clock.ts";
import {
  InterruptedError,
  runFiber,
  type AsyncOp,
  type AsyncRuntime,
  type FiberHandle,
} from "./runtime.ts";

export type AsyncRow = { async: Op<AsyncOp, unknown> };

const asyncOp = <A>(execute: (rt: AsyncRuntime) => Promise<A>) =>
  makeOp("async", { execute } satisfies AsyncOp) as Kyoot<A, AsyncRow>;

export const intercept = makeIntercept<"async", AsyncOp, unknown>("async");

export const fromPromise = <A>(f: (signal: AbortSignal) => Promise<A>) =>
  asyncOp((rt) => f(rt.signal));

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

type FailOf<S> = Payload<S, "fail">;

export type InterruptedCause = { readonly _tag: "Interrupted" };

export type Exit<E, A> = Result<E, A> | Err<InterruptedCause>;

const interrupted: Err<InterruptedCause> = { ok: false, cause: { _tag: "Interrupted" } };

export interface Fiber<A, E = never> {
  readonly join: Kyoot<A, MergeAll<AsyncRow | FailRow<E>>>;
  readonly await: Kyoot<Exit<E, A>, AsyncRow>;
  readonly interrupt: Kyoot<void, AsyncRow>;
}

interface Spawned<A, E> {
  readonly promise: Promise<Exit<E, A>>;
  readonly interrupt: () => void;
}

const spawn = <A, E>(rt: AsyncRuntime, k: AnyKyoot): Spawned<A, E> => {
  let exit: Result<E, A> | undefined;
  const record = (r: Result<E, A>) => ((exit = r), succeed(undefined));
  const failed = (e: E) => record(Result.fail(e));
  const h: FiberHandle = rt.spawn(
    makeHandler(
      "fail",
      k.flatMap((a) => record(Result.ok(a))),
      failed,
    ),
  );
  return {
    promise: h.promise.then(
      () => exit!,
      (e: unknown) => (e instanceof InterruptedError ? interrupted : Result.defect(e)),
    ),
    interrupt: h.interrupt,
  };
};

const land = <A, E>(exit: Exit<E, A>): Result<E, A> => {
  if (!exit.ok && exit.cause._tag === "Interrupted") throw new InterruptedError();
  return exit as Result<E, A>;
};

const fiber = <A, E>(h: Spawned<A, E>): Fiber<A, E> => {
  const result = asyncOp(() => h.promise);
  return {
    join: asyncOp(() => h.promise.then(land)).flatMap(fromResult),
    await: result,
    interrupt: asyncOp(async () => h.interrupt()),
  };
};

const settle = (fibers: ReadonlyArray<Spawned<unknown, unknown>>) =>
  Promise.allSettled(fibers.map((f) => (f.interrupt(), f.promise)));

export const fork = <A, S extends Row>(
  k: Kyoot<A, S> & Only<S, "async" | "fail">,
): Kyoot<Fiber<A, FailOf<S>>, AsyncRow> => asyncOp((rt) => Promise.resolve(fiber(spawn(rt, k))));

export const race = <A, B, S1 extends Row, S2 extends Row>(
  a: Kyoot<A, S1> & Only<S1, "async" | "fail">,
  b: Kyoot<B, S2> & Only<S2, "async" | "fail">,
): Kyoot<A | B, MergeAll<AsyncRow | FailRow<FailOf<S1> | FailOf<S2>>>> =>
  asyncOp((rt) => {
    const fibers = [spawn<A | B, unknown>(rt, a), spawn<A | B, unknown>(rt, b)];
    return Promise.race(fibers.map((f) => f.promise))
      .finally(() => settle(fibers))
      .then(land);
  }).flatMap(fromResult) as never;

export const all = <A, S extends Row = {}>(
  ks: ReadonlyArray<Kyoot<A, S> & Only<S, "async" | "fail">>,
  options: { readonly concurrency?: number } = {},
): Kyoot<A[], MergeAll<AsyncRow | FailRow<FailOf<S>>>> =>
  asyncOp(async (rt): Promise<Result<unknown, A[]>> => {
    const concurrency = options.concurrency ?? ks.length;
    const workers = Math.min(
      ks.length,
      Math.max(1, Number.isNaN(concurrency) ? ks.length : Math.floor(concurrency)),
    );
    const results: A[] = new Array(ks.length);
    const fibers: Spawned<A, unknown>[] = [];
    let next = 0;
    let stopped: Exit<unknown, A[]> | undefined;
    const worker = async () => {
      while (stopped === undefined && next < ks.length) {
        const i = next++;
        const f = spawn<A, unknown>(rt, ks[i]!);
        fibers.push(f);
        const r = await f.promise;
        if (r.ok) {
          results[i] = r.value;
          continue;
        }
        if (stopped === undefined) {
          stopped = r;
          for (const other of fibers) other.interrupt();
        }
      }
    };
    await Promise.all(Array.from({ length: workers }, worker));
    if (stopped === undefined) return Result.ok(results);
    await settle(fibers);
    return land(stopped);
  }).flatMap(fromResult) as never;

export class Timeout {
  readonly _tag = "Timeout";
  readonly ms: number;
  constructor(ms: number) {
    this.ms = ms;
  }
}

export const timeout = <A, S extends Row>(ms: number, k: Kyoot<A, S> & Only<S, "async" | "fail">) =>
  race(
    k,
    sleep(ms)
      .pipe(live)
      .flatMap(() => fail(new Timeout(ms))),
  );

export const fromAsyncIterable = <E>(items: AsyncIterable<E>) =>
  gen(function* () {
    const it = items[Symbol.asyncIterator]();
    while (true) {
      const r = yield* next(it);
      if (r.done) return;
      yield* value(r.value);
    }
  });

export const toAsyncIterable = <S extends Row & { emit?: Op<unknown, void> }>(
  k: Kyoot<unknown, S> & Only<S, "emit" | "async">,
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
        forEach((e) => {
          buffer.push(e as Payload<S, "emit">);
          if (buffer.length < capacity) {
            wake();
            return;
          }
          const parked = new Promise<void>((r) => (drain = r));
          wake();
          return fromPromise(() => parked);
        }),
      ) as never,
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
