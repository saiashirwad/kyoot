export type Cause<E> =
  | { readonly _tag: "Fail"; readonly error: E }
  | { readonly _tag: "Defect"; readonly defect: unknown }
  | { readonly _tag: "Interrupted" };

export type Result<E, A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly cause: Cause<E> };

export const Cause = {
  fail<E>(error: E): Cause<E> {
    return { _tag: "Fail", error };
  },
  defect<E = never>(defect: unknown): Cause<E> {
    return { _tag: "Defect", defect };
  },
  interrupted<E = never>(): Cause<E> {
    return { _tag: "Interrupted" };
  },
};

export const Result = {
  ok<E = never, A = unknown>(value: A): Result<E, A> {
    return { ok: true, value };
  },
  fail<E, A = never>(error: E): Result<E, A> {
    return { ok: false, cause: Cause.fail(error) };
  },
  defect<E = never, A = never>(defect: unknown): Result<E, A> {
    return { ok: false, cause: Cause.defect(defect) };
  },
  interrupted<E = never, A = never>(): Result<E, A> {
    return { ok: false, cause: Cause.interrupted() };
  },
};
