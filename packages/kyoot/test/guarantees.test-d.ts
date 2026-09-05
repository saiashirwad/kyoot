import { Fail, Kyoot, Retry, Var } from "../src/index.ts";
import type { Kyoot as KyootT } from "../src/index.ts";

const State = Var.tag<number>()("guarantees");
const read: KyootT<number, { "var/guarantees": number }> = State.get();
const write: KyootT<void, { "var/guarantees": number }> = State.set(1);
const update: KyootT<void, { "var/guarantees": number }> = State.update((n) => n + 1);

// @ts-expect-error get answers with the variable value, not void
const badRead: KyootT<void, { "var/guarantees": number }> = State.get();
// @ts-expect-error set answers with void, not the variable value
const badWrite: KyootT<number, { "var/guarantees": number }> = State.set(1);
// @ts-expect-error update answers with void, not the variable value
const badUpdate: KyootT<number, { "var/guarantees": number }> = State.update((n) => n + 1);

const actual = Fail.fail("actual" as const);
// @ts-expect-error a retry predicate cannot demand fields absent from the failure
actual.pipe(Retry.run({ while: (error: { missing: string }) => Boolean(error.missing) }));

type One = { readonly _tag: "One"; readonly one: true };
type Two = { readonly _tag: "Two"; readonly two: true };
const unionFailure = Fail.fail(null as unknown as One | Two);
// @ts-expect-error a retry predicate must accept every member of a union failure
unionFailure.pipe(Retry.run({ while: (error: One) => error.one }));

// A correctly typed predicate remains accepted.
unionFailure.pipe(Retry.run({ while: (error: One | Two) => error._tag === "One" }));

State.intercept({
  get: (op, next) => {
    const value: KyootT<number, { "var/guarantees": number }> = next(op);
    // @ts-expect-error get interception resumes with the variable value
    const wrong: KyootT<void, { "var/guarantees": number }> = next(op);
    void value;
    void wrong;
    return next(op);
  },
  set: (op, next) => {
    const value: KyootT<void, { "var/guarantees": number }> = next(op);
    // @ts-expect-error set interception resumes with void
    const wrong: KyootT<number, { "var/guarantees": number }> = next(op);
    void value;
    void wrong;
    return next(op);
  },
  update: (op, next) => next(op),
});

// @ts-expect-error get interceptors must return the variable value
State.intercept({ get: () => Kyoot.succeed("wrong") });
// @ts-expect-error set interceptors must return void
State.intercept({ set: () => Kyoot.succeed(123) });
