import type { Kyoot } from "../model.ts";
import type { MergeAll, Op, Row } from "../types.ts";
import * as Clock from "./clock.ts";
import * as Fail from "../effects/fail.ts";

export interface Policy {
  readonly times: number;
  readonly delay?: number | ((attempt: number) => number);
  readonly while?: (error: unknown) => boolean;
}

const delayOf = ({ delay = 0 }: Policy, attempt: number) =>
  typeof delay === "function" ? delay(attempt) : delay;

export const run =
  (policy: Policy) =>
  <A, S extends Row & { fail?: Op<unknown, never> }>(
    k: Kyoot<A, S>,
  ): Kyoot<A, MergeAll<S | { clock: Op<number, void> }>> => {
    const attempt = (tries: number): Kyoot<A, any> =>
      k.pipe(
        Fail.catchAll((e: unknown): Kyoot<A, any> =>
          tries >= policy.times || policy.while?.(e) === false
            ? Fail.fail(e)
            : Clock.sleep(delayOf(policy, tries)).flatMap(() => attempt(tries + 1)),
        ),
      );
    return attempt(0) as never;
  };
