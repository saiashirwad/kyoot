import { effect } from "../core.ts";

const random = effect<void, number>()("random");

const nextOp = random(undefined);

export const next = () => nextOp;

export const handle = random.handle;

export const intercept = random.intercept;

export const int = (max: number) => {
  if (!Number.isSafeInteger(max) || max <= 0) {
    throw new RangeError("Random.int bound must be a positive safe integer");
  }
  return next().map((x) => Math.floor(x * max));
};

export const live = random.handle({ onOp: (_, resume) => resume(Math.random()) });

const step = (seed: number) => {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, seed + 0x6d2b79f5] as const;
};

export const seeded = (seed: number) =>
  random.handle({
    initial: seed,
    onOp: (_, resume, s) => {
      const [x, s2] = step(s);
      return resume(x, s2);
    },
  });
