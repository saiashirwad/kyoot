import {
  makeIntercept,
  fail,
  inherit,
  InterruptedError,
  unsafeMakeHandler,
  makeOp,
  succeed,
  type Payload,
  type DependentRequirement,
} from "../core.ts";
import { fromResult } from "./fail.ts";
import { sleep } from "./clock.ts";
import { Result } from "../result.ts";
import type { AnyKyoot, Kyoot, Snapshot, ValueOf, RowOf } from "../model.ts";
import type { AsyncOp, AsyncRuntime, FiberHandle, ServedKeys } from "../runtime.ts";
import type { FailRow, MergeAll, Row } from "../types.ts";

declare const family: unique symbol;
export type AsyncRow = { async: DependentRequirement<AsyncOp, unknown, typeof family> };

const asyncOp = <A>(execute: (rt: AsyncRuntime) => Promise<A>) =>
  makeOp("async", { execute } as AsyncOp) as Kyoot<A, AsyncRow>;

const NO_FRAMES: readonly Snapshot[] = [];

const spawning = <A>(execute: (rt: AsyncRuntime) => Promise<A>) =>
  makeOp("async", { execute } as AsyncOp, NO_FRAMES) as Kyoot<A, AsyncRow>;

export const unsafeIntercept = makeIntercept<"async", AsyncOp, unknown, {}, AsyncRow["async"]>(
  "async",
);

export const fromPromise = <A>(f: (signal: AbortSignal) => Promise<A>) =>
  asyncOp((rt) => f(rt.signal));

export const never = fromPromise<never>(() => new Promise(() => {}));

export const mapPromise = <A, B>(
  values: ReadonlyArray<A>,
  f: (value: A, index: number, signal: AbortSignal) => Promise<B>,
): Kyoot<B[], AsyncRow> =>
  fromPromise(async (signal) => {
    const count = values.length;
    const results: B[] = new Array(count);
    for (let index = 0; index < count; index++) {
      if (signal.aborted) throw new InterruptedError();
      results[index] = await f(values[index]!, index, signal);
    }
    return results;
  });

export const forEachPromise = <A>(
  values: ReadonlyArray<A>,
  f: (value: A, index: number, signal: AbortSignal) => Promise<unknown>,
): Kyoot<void, AsyncRow> =>
  fromPromise(async (signal) => {
    const count = values.length;
    for (let index = 0; index < count; index++) {
      if (signal.aborted) throw new InterruptedError();
      await f(values[index]!, index, signal);
    }
  });

export const reducePromise = <A, B>(
  values: ReadonlyArray<A>,
  initial: B,
  f: (accumulator: B, value: A, index: number, signal: AbortSignal) => Promise<B>,
): Kyoot<B, AsyncRow> =>
  fromPromise(async (signal) => {
    const count = values.length;
    let accumulator = initial;
    for (let index = 0; index < count; index++) {
      if (signal.aborted) throw new InterruptedError();
      accumulator = await f(accumulator, values[index]!, index, signal);
    }
    return accumulator;
  });

type FailOf<S> = Payload<S, "fail">;

type Leftover<S extends Row> = Omit<S, ServedKeys<S> | "fail">;

export interface Fiber<A, E = never> {
  readonly join: Kyoot<A, MergeAll<AsyncRow | FailRow<E>>>;
  readonly await: Kyoot<Result<E, A>, AsyncRow>;
  readonly interrupt: Kyoot<void, AsyncRow>;
}

interface Spawned<A, E> {
  readonly promise: Promise<Result<E, A>>;
  readonly interrupt: () => void;
}

const spawn = <A, E>(rt: AsyncRuntime, k: AnyKyoot): Spawned<A, E> => {
  let exit: Result<E, A> | undefined;
  const record = (r: Result<E, A>) => ((exit = r), succeed(undefined));
  const failed = (e: E) => record(Result.fail(e));
  const inner = unsafeMakeHandler("fail", k, {
    fork: "none",
    onOp: failed,
    onSuccess: (a: A) => record(Result.ok(a)),
  });
  const handlers = rt.handlers?.filter((h) => h.node.b !== "fail");
  const outer = unsafeMakeHandler("fail", inherit(inner, handlers), { fork: "none", onOp: failed });
  const h: FiberHandle = rt.spawn(outer);
  return {
    promise: h.promise.then(
      () =>
        exit ??
        Result.defect(
          new Error(
            'a handler copied into a fiber returned a value instead of resuming; give it fork: "none"',
          ),
        ),
      (e: unknown) => (e instanceof InterruptedError ? Result.interrupted() : Result.defect(e)),
    ),
    interrupt: h.interrupt,
  };
};

const fiber = <A, E>(h: Spawned<A, E>): Fiber<A, E> => {
  const result = asyncOp(() => h.promise);
  return {
    join: result.flatMap(fromResult) as never,
    await: result,
    interrupt: asyncOp(async () => h.interrupt()),
  };
};

const settle = (fibers: ReadonlyArray<Spawned<unknown, unknown>>) =>
  Promise.allSettled(fibers.map((f) => (f.interrupt(), f.promise)));

export const fork = <A, S extends Row>(
  k: Kyoot<A, S>,
): Kyoot<Fiber<A, FailOf<S>>, MergeAll<AsyncRow | Leftover<S>>> =>
  spawning((rt) => Promise.resolve(fiber(spawn(rt, k)))) as never;

export const race = <A, B, S1 extends Row, S2 extends Row>(
  a: Kyoot<A, S1>,
  b: Kyoot<B, S2>,
): Kyoot<
  A | B,
  MergeAll<AsyncRow | Leftover<S1> | Leftover<S2> | FailRow<FailOf<S1> | FailOf<S2>>>
> =>
  spawning((rt) => {
    const fibers = [spawn<A | B, unknown>(rt, a), spawn<A | B, unknown>(rt, b)];
    return Promise.race(fibers.map((f) => f.promise)).finally(() => settle(fibers));
  }).flatMap(fromResult) as never;

export const all = <K extends AnyKyoot>(
  ks: ReadonlyArray<K>,
  options: { readonly concurrency?: number } = {},
): Kyoot<
  ValueOf<K>[],
  MergeAll<AsyncRow | Leftover<MergeAll<RowOf<K>>> | FailRow<FailOf<MergeAll<RowOf<K>>>>>
> =>
  spawning(async (rt): Promise<Result<unknown, ValueOf<K>[]>> => {
    const concurrency = options.concurrency ?? ks.length;
    const workers = Math.min(
      ks.length,
      Math.max(1, Number.isNaN(concurrency) ? ks.length : Math.floor(concurrency)),
    );
    const results: ValueOf<K>[] = new Array(ks.length);
    const fibers: Spawned<ValueOf<K>, unknown>[] = [];
    let next = 0;
    let stopped: Result<unknown, ValueOf<K>[]> | undefined;
    const worker = async () => {
      while (stopped === undefined && next < ks.length) {
        const i = next++;
        const f = spawn<ValueOf<K>, unknown>(rt, ks[i]!);
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
    return stopped;
  }).flatMap(fromResult) as never;

export class Timeout {
  readonly _tag = "Timeout";
  readonly ms: number;
  constructor(ms: number) {
    this.ms = ms;
  }
}

const timedOut = Symbol("timeout");

export const timeout = <A, S extends Row>(ms: number, k: Kyoot<A, S>) =>
  race(
    k,
    sleep(ms).map(() => timedOut),
  ).flatMap((r) => (r === timedOut ? fail(new Timeout(ms)) : succeed(r as A)));
