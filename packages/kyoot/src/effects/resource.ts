import { gen, isKyoot, makeHandler, makeIntercept, op, succeed } from "../core.ts";
import type { Kyoot, RowOf } from "../model.ts";
import type { MergeAll, Row } from "../types.ts";

type Finalizer = () => unknown;

export interface ResourceOp<S extends Row = {}> {
  readonly _?: (s: S) => void;
  readonly acquire: () => unknown;
  readonly release: (r: unknown) => unknown;
}

export const acquire = <R, C>(open: () => R, close: (r: R) => C) =>
  op<R>()("resource", { acquire: open, release: close } as ResourceOp<RowOf<C>>);

// Wrap acquire and release: count what is open, log it, fake it. `S` is
// the row the program's finalizers need, `{}` when they need nothing.
export const intercept = <S extends Row = {}>() =>
  makeIntercept<"resource", ResourceOp<S>, unknown>("resource");

const unit = succeed(undefined);

// A scope around one finalizer, there for its `onDefect`: a finalizer that
// throws is noted and the rest still run. Its key is never performed.
const attempting = Symbol("resource/finalizer");

const attempt = (f: Finalizer, errors: unknown[]) =>
  makeHandler(
    attempting,
    unit.flatMap(() => {
      const r = f();
      return isKyoot(r) ? r : succeed(r);
    }),
    {
      onOp: () => {
        throw new Error("unreachable");
      },
      onDefect: (d) => {
        errors.push(d);
        return unit;
      },
    },
  );

// Run every finalizer, last acquired first; the errors they threw come back.
const finalize = (finalizers: readonly Finalizer[]) =>
  gen(function* () {
    const errors: unknown[] = [];
    for (let i = finalizers.length - 1; i >= 0; i--) yield* attempt(finalizers[i]!, errors);
    return errors;
  });

type ReleaseRow<R> = R extends ResourceOp<infer S> ? S : never;

// The finalizer list is a cell made per run, so it grows in place.
export const run = <A, S extends Row & { resource?: ResourceOp<any> }>(
  k: Kyoot<A, S>,
): Kyoot<A, MergeAll<Omit<S, "resource"> | ReleaseRow<S["resource"]>>> =>
  makeHandler("resource", k, {
    // A fiber gets a scope of its own, released when the fiber ends.
    fork: "scope",
    create: () => [] as Finalizer[],
    onOp: (res, resume, finalizers) => {
      const r = res.acquire();
      finalizers.push(() => res.release(r));
      return resume(r);
    },
    onSuccess: (a, finalizers) =>
      finalize(finalizers).map((errors) => {
        if (errors.length > 0) throw errors[0];
        return a;
      }),
    onDefect: (d, finalizers) =>
      finalize(finalizers).map(() => {
        throw d;
      }),
    onInterrupt: (finalizers) => finalize(finalizers),
  }) as never;
