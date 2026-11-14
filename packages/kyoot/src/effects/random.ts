import { effect, gen } from "../core.ts";
import type { Kyoot } from "../model.ts";
import type { MergeAll, Op, Row } from "../types.ts";

const random = effect<void, number>()("random");

const nextOp = random(undefined);

export const next = () => nextOp;

export const handle = random.handle;

export const intercept = random.intercept;

export const int = (max: number) => next().map((x) => Math.floor(x * max));

export const live = random.handle((_, resume) => resume(Math.random()));

const step = (seed: number) => {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, seed + 0x6d2b79f5] as const;
};

export const seeded =
  (seed: number) =>
  <A, S extends Row & { random?: Op<void, number> }>(
    k: Kyoot<A, S>,
  ): Kyoot<A, MergeAll<Omit<S, "random">>> =>
    gen(function* () {
      let s = seed;
      return yield* k.pipe(
        random.handle((_, resume) => {
          const [x, s2] = step(s);
          s = s2;
          return resume(x);
        }),
      );
    }) as never;
