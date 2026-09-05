import {
  InterruptedError,
  isKyoot,
  makeHandler,
  makeIntercept,
  makeOp,
  op,
  succeed,
} from "../core.ts";
import { Scope, ScopeAwait, type Finalizer, type ScopeAwaitOp } from "../internal/scope.ts";
import { CleanupError, Result, type Cause, type CleanupFailure } from "../result.ts";
import type {
  AnyKyoot,
  KnownOperationsOf,
  Kyoot,
  Operation,
  RemoveOperations,
  RuntimeResume,
} from "../model.ts";
import type { MergeAll, Remove, Row } from "../types.ts";
import * as Async from "./async.ts";

export interface ResourceOp<S extends Row = {}> {
  readonly _?: (s: S) => void;
  readonly acquire: () => unknown;
  readonly release: (r: unknown) => unknown;
  readonly effectfulAcquire?: boolean;
}

type ReleaseRowOf<C> =
  C extends Kyoot<any, infer S>
    ? S
    : C extends PromiseLike<any>
      ? { async: import("../runtime.ts").AsyncOp }
      : {};

export const acquire = <R, C>(open: () => R, close: (r: R) => C) =>
  op<R>()("resource", { acquire: open, release: close } as ResourceOp<ReleaseRowOf<C>>) as Kyoot<
    R,
    { resource: ResourceOp<ReleaseRowOf<C>> },
    Operation<"resource", ResourceOp<ReleaseRowOf<C>>, R> | KnownOperationsOf<C>
  >;

/** Acquire and release a resource with Kyoot programs. */
export const acquireEffect = <
  R,
  AS extends Row,
  C,
  RS extends Row = {},
  AOps = unknown,
  ROps = unknown,
>(
  open: () => Kyoot<R, AS, AOps>,
  close: (r: R) => Kyoot<C, RS, ROps>,
) =>
  op<R>()("resource", {
    acquire: open,
    release: close,
    effectfulAcquire: true,
  } as ResourceOp<MergeAll<AS | RS>>) as Kyoot<
    R,
    { resource: ResourceOp<MergeAll<AS | RS>> },
    | Operation<"resource", ResourceOp<MergeAll<AS | RS>>, R>
    | KnownOperationsOf<Kyoot<R, AS, AOps> | Kyoot<C, RS, ROps>>
  >;

/** Acquire and release a resource with promises. */
export const acquirePromise = <R, C>(open: () => Promise<R>, close: (r: R) => Promise<C>) =>
  op<R>()("resource", {
    acquire: open,
    release: close,
    effectfulAcquire: true,
  } as ResourceOp<{ async: import("../runtime.ts").AsyncOp }>);

export const intercept = <R, S extends Row = {}>() =>
  makeIntercept<"resource", ResourceOp<S>, R>("resource");

const unit = succeed(undefined);
const attempting = Symbol("resource/finalizer");
const acquiring = Symbol("resource/acquiring");

interface Closing {
  readonly finalizers: readonly Finalizer[];
  readonly failures: CleanupFailure[];
  readonly done: (failures: readonly CleanupFailure[]) => AnyKyoot;
  index: number;
}

const failureOf = (cause: Cause<unknown>): CleanupFailure[] => {
  let failure: CleanupFailure;
  switch (cause._tag) {
    case "Fail":
      failure = { _tag: "Fail", error: cause.error };
      break;
    case "Defect":
      failure = { _tag: "Defect", defect: cause.defect };
      break;
    case "Interrupted":
      failure = { _tag: "Interrupted" };
      break;
  }
  return [failure, ...(cause.cleanup ?? [])];
};

const recordDefect = (failures: CleanupFailure[], defect: unknown): void => {
  if (defect instanceof CleanupError) {
    if (defect.primary !== undefined) failures.push(...failureOf(defect.primary));
    failures.push(...defect.failures);
  } else {
    failures.push({ _tag: "Defect", defect });
  }
};

const asEffect = <A>(value: A | Kyoot<A, Row> | PromiseLike<A>): Kyoot<A, Row> => {
  if (isKyoot(value)) return value as Kyoot<A, Row>;
  if (typeof (value as PromiseLike<A>)?.then === "function") {
    const promise = Promise.resolve(value as PromiseLike<A>);
    void promise.catch(() => {});
    return Async.fromPromise(() => promise) as Kyoot<A, Row>;
  }
  return succeed(value as A) as Kyoot<A, Row>;
};

const next = (closing: Closing): AnyKyoot => {
  const finalizer = closing.finalizers[closing.index++];
  if (finalizer === undefined) return unit.flatMap(() => closing.done(closing.failures));

  const body = unit.flatMap(() => {
    return asEffect(finalizer());
  });
  const caughtFailure = makeHandler("fail", body, {
    onOp: (error) => {
      closing.failures.push({ _tag: "Fail", error });
      return unit;
    },
  });

  return makeHandler(attempting, caughtFailure, {
    interruptMask: true,
    recoverInterrupt: true,
    onOp: () => {
      throw new Error("unreachable resource finalizer handler");
    },
    onSuccess: () => next(closing),
    onDefect: (defect: unknown) => {
      recordDefect(closing.failures, defect);
      return next(closing);
    },
    onInterrupt: (_state: unknown, cause: unknown) => {
      if (cause !== undefined) closing.failures.push({ _tag: "Interrupted" });
      return next(closing);
    },
  } as never);
};

const finalize = (
  scope: Scope,
  done: (failures: readonly CleanupFailure[]) => AnyKyoot,
): AnyKyoot => {
  const closing = scope.close();
  const finalizers: Finalizer[] = [];
  if (closing.children !== undefined) {
    const children = closing.children;
    finalizers.push(() => makeOp(ScopeAwait, { execute: () => children } satisfies ScopeAwaitOp));
  }
  finalizers.push(...closing.finalizers);
  return next({ finalizers, failures: [], done, index: 0 });
};

const mergeCleanupError = (primary: unknown, failures: readonly CleanupFailure[]): CleanupError =>
  primary instanceof CleanupError
    ? new CleanupError(primary.primary, [...primary.failures, ...failures])
    : new CleanupError({ _tag: "Defect", defect: primary }, failures);

const finishSuccess = (value: unknown, failures: readonly CleanupFailure[]): AnyKyoot => {
  if (failures.length === 0) return succeed(value);
  const amended = Result.addCleanupTo(value, failures);
  if (amended !== undefined) return succeed(amended);
  throw new CleanupError(undefined, failures);
};

type ReleaseRow<R> = R extends ResourceOp<infer S> ? S : never;

export const run = <A, S extends Row & { resource?: ResourceOp<never> }, Ops>(
  k: Kyoot<A, S, Ops>,
): Kyoot<
  A,
  MergeAll<Remove<S, "resource"> | ReleaseRow<S["resource"]>>,
  RemoveOperations<Ops, "resource">
> =>
  makeHandler("resource", k, {
    fork: "scope",
    create: () => new Scope(),
    onOp: (resource: ResourceOp<any>, resume: RuntimeResume, scope: Scope) => {
      const acquired = resource.effectfulAcquire
        ? asEffect(resource.acquire())
        : (succeed(resource.acquire()) as Kyoot<unknown, Row>);
      const registered = acquired.flatMap((value) => {
        scope.addFinalizer(() => resource.release(value));
        return succeed(value);
      });
      return makeHandler(acquiring, registered, {
        interruptMask: true,
        onOp: () => {
          throw new Error("unreachable resource acquisition handler");
        },
      } as never).flatMap((value) => resume(value));
    },
    onSuccess: (value: A, scope: Scope) =>
      finalize(scope, (failures) => finishSuccess(value, failures)),
    onDefect: (defect: unknown, scope: Scope) =>
      finalize(scope, (failures) => {
        if (failures.length > 0) throw mergeCleanupError(defect, failures);
        throw defect;
      }),
    onInterrupt: (scope: Scope, cause: unknown) =>
      finalize(scope, (failures) => {
        if (failures.length > 0) {
          if (cause instanceof InterruptedError) {
            cause.addCleanup(failures);
            return unit;
          }
          throw new CleanupError(undefined, failures);
        }
        return unit;
      }),
  } as never) as never;
