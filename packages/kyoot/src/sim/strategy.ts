// Which runnable fiber goes next. A strategy makes a chooser per run; the scheduler asks it once per
// step and records the index it answers, so any run can be replayed with Sim.replay(result.choices).

// Given the runnable fibers' ids (in scheduler order) and the step number, answers an index into them.
export type Chooser = (runnable: ReadonlyArray<number>, step: number) => number;

export interface Strategy {
  readonly name: string;
  chooser(seed: number): Chooser;
}

// mulberry32: small, fast and good enough to pick fibers.
export const prng = (seed: number) => {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// `count` distinct steps in [0, steps).
const points = (r: () => number, count: number, steps: number) => {
  const out = new Set<number>();
  while (out.size < Math.min(count, steps)) out.add(Math.floor(r() * steps));
  return [...out];
};

// Uniform over the runnable fibers at every step. The default.
export const random = (): Strategy => ({
  name: "random",
  chooser: (seed) => {
    const r = prng(seed);
    return (runnable) => Math.floor(r() * runnable.length);
  },
});

/**
 * PCT (Burckhardt et al., 2010). Each fiber gets a random priority and the highest runnable one
 * always runs; at depth-1 random steps the fiber about to run is demoted below everyone. A bug that
 * needs d specific ordering constraints is hit with probability about 1 / (fibers * steps^(d-1))
 * per run, instead of shrinking exponentially with the schedule length as under random choice.
 * `steps` is a guess at how many scheduling steps a run takes (change points land in [0, steps)).
 */
export const pct = (
  options: { readonly depth?: number; readonly steps?: number } = {},
): Strategy => {
  const { depth = 2, steps = 100 } = options;
  return {
    name: `pct(depth=${depth})`,
    chooser: (seed) => {
      const r = prng(seed ^ 0x9e3779b9);
      const priority = new Map<number, number>();
      // The i-th change point demotes to priority i, below every initial one (which are >= depth).
      const demote = new Map(points(r, depth - 1, steps).map((step, i) => [step, i]));
      const best = (runnable: ReadonlyArray<number>) => {
        let at = 0;
        for (const [i, id] of runnable.entries()) {
          if (!priority.has(id)) priority.set(id, depth + r());
          if (priority.get(id)! > priority.get(runnable[at]!)!) at = i;
        }
        return at;
      };
      return (runnable, step) => {
        let at = best(runnable);
        const low = demote.get(step);
        if (low !== undefined) {
          priority.set(runnable[at]!, low);
          at = best(runnable);
        }
        return at;
      };
    },
  };
};

/**
 * Bounded preemption (as in CHESS): keep running the same fiber while it can, and switch away from
 * a runnable fiber only at `preemptions` random steps. Switching because it blocked is free.
 */
export const bounded = (
  options: { readonly preemptions?: number; readonly steps?: number } = {},
): Strategy => {
  const { preemptions = 2, steps = 100 } = options;
  return {
    name: `bounded(preemptions=${preemptions})`,
    chooser: (seed) => {
      const r = prng(seed ^ 0x85ebca6b);
      const at = new Set(points(r, preemptions, steps));
      let last = -1;
      return (runnable, step) => {
        const stay = runnable.indexOf(last);
        let i: number;
        if (stay >= 0 && !(at.has(step) && runnable.length > 1)) i = stay;
        else {
          i = Math.floor(r() * (runnable.length - (stay >= 0 ? 1 : 0)));
          if (stay >= 0 && i >= stay) i++;
        }
        last = runnable[i]!;
        return i;
      };
    },
  };
};

/**
 * Replays recorded choices (SimResult.choices). Indices are taken modulo the runnable count and
 * missing ones default to 0, so an edited or shortened list still runs: a shrinker can drop or
 * change choices freely. Pass the original seed too if the world uses random().
 */
export const replay = (choices: ReadonlyArray<number>): Strategy => ({
  name: "replay",
  chooser: () => (runnable, step) => (choices[step] ?? 0) % runnable.length,
});
