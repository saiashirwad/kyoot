import type { Kyoot } from "../model.ts";
import type { MergeAll, Row } from "../types.ts";
import * as Clock from "./clock.ts";
import * as Fail from "./fail.ts";

export interface Policy {
  readonly times: number;
  readonly delay?: number | ((attempt: number) => number);
  readonly while?: (error: unknown) => boolean;
}

const delayOf = ({ delay = 0 }: Policy, attempt: number) =>
  typeof delay === "function" ? delay(attempt) : delay;

// Re-runs `k` on a typed failure; defects and interruption pass straight through.
export const run =
  (policy: Policy) =>
  <A, S extends Row & { fail?: unknown }>(
    k: Kyoot<A, S>,
  ): Kyoot<A, MergeAll<S | { clock: number }>> => {
    const attempt = (tries: number): Kyoot<A, any> =>
      k.pipe(
        Fail.catchAll((e: unknown) =>
          tries >= policy.times || policy.while?.(e) === false
            ? Fail.fail(e)
            : Clock.sleep(delayOf(policy, tries)).flatMap(() => attempt(tries + 1)),
        ),
      );
    return attempt(0);
  };
