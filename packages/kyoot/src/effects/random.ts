import { effect, answering } from "../core.ts";

const random = effect<void, number>()("random");

const nextOp = random(undefined);

export const next = () => nextOp;

export const handle = random.handle;

export const handleWith = random.handleWith;

export const intercept = random.intercept;

export const int = (max: number) => next().map((x) => Math.floor(x * max));

export const live = answering("random", (_: void) => Math.random());

const step = (seed: number) => {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, seed + 0x6d2b79f5] as const;
};

export const seeded = (seed: number) =>
  random.handleWith(() => {
    let s = seed;
    return (_, resume) => {
      const [x, s2] = step(s);
      s = s2;
      return resume(x);
    };
  });
