export type CleanupFailure =
  | { readonly _tag: "Fail"; readonly error: unknown }
  | { readonly _tag: "Defect"; readonly defect: unknown }
  | { readonly _tag: "Interrupted" };

interface WithCleanup {
  readonly cleanup?: readonly CleanupFailure[];
}

export type FailCause<E> = WithCleanup & { readonly _tag: "Fail"; readonly error: E };
export type DefectCause = WithCleanup & { readonly _tag: "Defect"; readonly defect: unknown };
export type InterruptedCause = WithCleanup & { readonly _tag: "Interrupted" };
export type Cause<E> = FailCause<E> | DefectCause | InterruptedCause;

export type Ok<A> = { readonly ok: true; readonly value: A };
export type Err<C> = { readonly ok: false; readonly cause: C };
export type Result<E, A> = Ok<A> | Err<Cause<E>>;

export class CleanupError extends Error {
  readonly primary: Cause<unknown> | undefined;
  readonly failures: readonly CleanupFailure[];

  constructor(primary: Cause<unknown> | undefined, failures: readonly CleanupFailure[]) {
    super(
      primary === undefined
        ? `${failures.length} resource finalizer${failures.length === 1 ? "" : "s"} failed`
        : `${failures.length} resource finalizer${failures.length === 1 ? "" : "s"} failed after ${primary._tag.toLowerCase()}`,
      primary === undefined ? undefined : { cause: primary },
    );
    this.name = "CleanupError";
    this.primary = primary;
    this.failures = failures;
  }
}

const made = new WeakSet<object>();

const remember = <A extends object>(value: A): A => {
  made.add(value);
  return value;
};

const withCleanup = <E>(cause: Cause<E>, failures: readonly CleanupFailure[]): Cause<E> =>
  failures.length === 0
    ? cause
    : ({
        ...cause,
        cleanup: [...(cause.cleanup ?? []), ...failures],
      } as Cause<E>);

export const cleanupFailuresFrom = (error: CleanupError): readonly CleanupFailure[] => {
  if (error.primary === undefined) return error.failures;
  let primary: CleanupFailure;
  switch (error.primary._tag) {
    case "Fail":
      primary = { _tag: "Fail", error: error.primary.error };
      break;
    case "Defect":
      primary = { _tag: "Defect", defect: error.primary.defect };
      break;
    case "Interrupted":
      primary = { _tag: "Interrupted" };
      break;
  }
  return [primary, ...(error.primary.cleanup ?? []), ...error.failures];
};

const asResult = (value: unknown): Result<unknown, unknown> | undefined =>
  typeof value === "object" && value !== null && made.has(value)
    ? (value as Result<unknown, unknown>)
    : undefined;

export const Result = {
  ok<A>(value: A): Ok<A> {
    return remember({ ok: true, value });
  },
  fail<E>(error: E, cleanup: readonly CleanupFailure[] = []): Err<FailCause<E>> {
    return remember({
      ok: false,
      cause: withCleanup({ _tag: "Fail", error }, cleanup) as FailCause<E>,
    });
  },
  defect(defect: unknown, cleanup: readonly CleanupFailure[] = []): Err<DefectCause> {
    return remember({
      ok: false,
      cause: withCleanup({ _tag: "Defect", defect }, cleanup) as DefectCause,
    });
  },
  interrupted(cleanup: readonly CleanupFailure[] = []): Err<InterruptedCause> {
    return remember({
      ok: false,
      cause: withCleanup({ _tag: "Interrupted" }, cleanup) as InterruptedCause,
    });
  },
  fromDefect(defect: unknown): Err<Cause<unknown>> {
    if (!(defect instanceof CleanupError)) return this.defect(defect);
    if (defect.primary === undefined) return this.defect(defect, defect.failures);
    return remember({ ok: false, cause: withCleanup(defect.primary, defect.failures) });
  },
  addCleanup<E, A>(result: Result<E, A>, failures: readonly CleanupFailure[]): Result<E, A> {
    if (result.ok || failures.length === 0) return result;
    return remember({ ok: false, cause: withCleanup(result.cause, failures) });
  },
  addCleanupTo(value: unknown, failures: readonly CleanupFailure[]): unknown | undefined {
    const result = asResult(value);
    return result === undefined || result.ok ? undefined : this.addCleanup(result, failures);
  },
  is(value: unknown): value is Result<unknown, unknown> {
    return asResult(value) !== undefined;
  },
};
