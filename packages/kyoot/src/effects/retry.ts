import { gen } from "../core.ts";
import type { Kyoot } from "../model.ts";
import type { Row } from "../types.ts";
import * as Clock from "./clock.ts";
import * as Fail from "./fail.ts";

export interface Policy<E = unknown> {
  /** Number of retries after the first attempt. `times` remains an alias. */
  readonly retries?: number;
  readonly times?: number;
  readonly delay?: number | ((attempt: number) => number);
  readonly while?: (error: E) => boolean;
}

const delayOf = <E>({ delay = 0 }: Policy<E>, attempt: number) =>
  typeof delay === "function" ? delay(attempt) : delay;

export const run =
  <E>(policy: Policy<E>) =>
  <A, S extends Row & { fail?: E }, Ops>(k: Kyoot<A, S, Ops>) => {
    const retries = policy.retries ?? policy.times ?? 0;
    if (!Number.isSafeInteger(retries) || retries < 0) {
      throw new RangeError("retry count must be a non-negative integer");
    }
    if (typeof policy.delay === "number" && (!Number.isFinite(policy.delay) || policy.delay < 0)) {
      throw new RangeError("retry delay must be finite and non-negative");
    }
    const attempt = Fail.run(k);
    return gen(function* () {
      for (let tries = 0; ; tries++) {
        const r = yield* attempt;
        if (r.ok) return r.value;
        const stop = r.cause._tag !== "Fail" || policy.while?.(r.cause.error as E) === false;
        if (stop || tries >= retries) return yield* Fail.fromResult(r);
        const delay = delayOf(policy, tries);
        if (!Number.isFinite(delay) || delay < 0) {
          throw new RangeError("retry delay must be finite and non-negative");
        }
        yield* Clock.sleep(delay);
      }
    });
  };
