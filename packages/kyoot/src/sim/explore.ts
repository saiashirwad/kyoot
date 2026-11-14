import type { Kyoot } from "../model.ts";
import type { Row } from "../types.ts";
import {
  run,
  showExit,
  type FailOf,
  type RunOptions,
  type SimResult,
  type Simulable,
  type World,
} from "./scheduler.ts";
import type { Strategy } from "./strategy.ts";

export type Check<A, E, W> = (result: SimResult<A, E, W>) => boolean | string;

export interface Cost {
  readonly steps: number;
  readonly preemptions: number;
}

export interface Shrunk<A, E, W> {
  // The smallest failing run found: same seed, rerun it with Sim.replay(result.choices).
  readonly result: SimResult<A, E, W>;
  // Candidate schedules tried.
  readonly runs: number;
  readonly before: Cost;
  readonly after: Cost;
}

export type Explored<A, E, W> =
  | { readonly ok: true; readonly runs: number }
  | {
      readonly ok: false;
      readonly runs: number;
      readonly seed: number;
      readonly strategy: string;
      readonly reason: string;
      // The first failing run as found.
      readonly result: SimResult<A, E, W>;
      // Its minimal failing schedule (unless explore was given shrink: false).
      readonly shrunk?: Shrunk<A, E, W>;
    };

export const showShrink = (s: Shrunk<unknown, unknown, unknown>) =>
  `shrunk in ${s.runs} runs: ${s.before.steps} -> ${s.after.steps} steps, ${s.before.preemptions} -> ${s.after.preemptions} preemptions`;

const verdictOf = <A, E, W>(check: Check<A, E, W> | undefined, r: SimResult<A, E, W>) =>
  check === undefined ? r.exit.ok || showExit(r.exit) : check(r);

type Pins = ReadonlyMap<string, number>;
const pinKey = (fiber: number, taken: number) => `${fiber}:${taken}`;

// Stay on the running fiber while it can run (else the first runnable), except where a pin says
// "after fiber p's k-th step, run fiber f". Pins name the switch, not the step number, so they keep
// their meaning when other switches are dropped. Notes the pins that changed the default.
const guided = (pins: Pins, used: Map<string, number>): Strategy => ({
  name: "shrink",
  chooser: () => {
    let last = -1;
    const taken = new Map<number, number>();
    return (runnable) => {
      const stay = runnable.indexOf(last);
      const def = stay >= 0 ? stay : 0;
      const key = pinKey(last, taken.get(last) ?? 0);
      const want = pins.has(key) ? runnable.indexOf(pins.get(key)!) : -1;
      const i = want >= 0 ? want : def;
      if (i !== def) used.set(key, runnable[i]!);
      last = runnable[i]!;
      taken.set(last, (taken.get(last) ?? 0) + 1);
      return i;
    };
  },
});

type ShrinkOptions<S, W> = Omit<RunOptions<S, W>, "seed" | "strategy"> & {
  readonly check?: Check<unknown, FailOf<S>, W>;
  // Most candidate runs to try (default 500).
  readonly maxRuns?: number;
};

/**
 * Finds a smaller schedule that still fails. A schedule is described by its context switches: by
 * default a fiber keeps running until it blocks or ends, and each pin forces another fiber to run
 * after a given step of the current one. The pins of the failing run are delta-debugged (ddmin): drop chunks of them, rerun from
 * scratch with the same seed and world, and keep the result only if `check` still rejects it and it
 * has no more preemptions and no more steps. Deterministic: the same input shrinks the same way.
 */
export function shrink<A, S extends Row, W extends World<S> = World<S>>(
  program: Kyoot<A, S> & Simulable<S>,
  failing: SimResult<A, FailOf<S>, W>,
  options: ShrinkOptions<S, W>,
): Shrunk<A, FailOf<S>, W> {
  const { maxRuns = 500, check } = options as { maxRuns?: number; check?: Check<A, FailOf<S>, W> };
  const cost = (r: SimResult<A, FailOf<S>, W>): Cost => ({
    steps: r.steps,
    preemptions: r.preemptions,
  });
  const before = cost(failing);
  let runs = 0;
  const tried = new Map<string, SimResult<A, FailOf<S>, W> | undefined>();

  // Runs a candidate; answers it (with the pins that mattered) if it still fails.
  const attempt = (pins: Pins) => {
    const key = [...pins].join(";");
    if (tried.has(key) || runs >= maxRuns) return;
    runs++;
    const used = new Map<string, number>();
    const result = run(program, {
      ...options,
      seed: failing.seed,
      strategy: guided(pins, used),
      maxSteps: Math.max(failing.steps, 1),
    } as RunOptions<S, W>);
    const fails = verdictOf(check, result) !== true;
    tried.set(key, fails ? result : undefined);
    return fails ? { result, pins: used } : undefined;
  };

  const everything = new Map<string, number>();
  const taken = new Map<number, number>();
  let prev = -1;
  for (const id of failing.schedule) {
    everything.set(pinKey(prev, taken.get(prev) ?? 0), id);
    taken.set(id, (taken.get(id) ?? 0) + 1);
    prev = id;
  }
  const start = attempt(everything);
  if (start === undefined) return { result: failing, runs, before, after: before };

  let best = start.result;
  let pins = [...start.pins];
  const better = (r: SimResult<A, FailOf<S>, W>) =>
    r.steps <= before.steps &&
    (r.preemptions < best.preemptions ||
      (r.preemptions === best.preemptions && r.steps <= best.steps));

  // Accepts a candidate pin list if it still fails and is no worse than the best so far.
  const take = (candidate: Array<[string, number]>) => {
    const hit = attempt(new Map(candidate));
    if (hit === undefined || !better(hit.result)) return false;
    best = hit.result;
    pins = [...hit.pins];
    return true;
  };

  // ddmin: drop chunks of the pins, halving the chunk size until single pins.
  const dropPins = () => {
    let n = 2;
    while (pins.length > 0 && runs < maxRuns) {
      const parts = Math.min(n, pins.length);
      const size = Math.ceil(pins.length / parts);
      let reduced = false;
      for (let at = 0; at < pins.length; at += size) {
        if (take([...pins.slice(0, at), ...pins.slice(at + size)])) {
          n = Math.max(parts - 1, 2);
          reduced = true;
          break;
        }
      }
      if (reduced) continue;
      if (parts >= pins.length) break;
      n = Math.min(pins.length, parts * 2);
    }
  };

  // Merge two switches into one: p -> q then q -> r becomes p -> r.
  const mergePins = () => {
    for (let i = 0; i < pins.length; i++) {
      for (let j = i + 1; j < pins.length; j++) {
        const merged = pins.filter((_, k) => k !== j);
        merged[i] = [pins[i]![0], pins[j]![1]];
        // Also without the switches before it: they may only have been there to set it up.
        if (take(merged) || take(merged.slice(i))) return true;
      }
    }
    return false;
  };

  do dropPins();
  while (runs < maxRuns && mergePins());

  // Then move each switch as early as it still fails: the race reads best with the fewest steps
  // between the two sides.
  for (let i = 0; i < pins.length; i++) {
    for (;;) {
      const [fiber, taken] = pins[i]![0].split(":").map(Number) as [number, number];
      if (taken <= 1 || runs >= maxRuns) break;
      const moved = [...pins];
      moved[i] = [pinKey(fiber, taken - 1), pins[i]![1]];
      const hit = attempt(new Map(moved));
      if (hit === undefined || !better(hit.result)) break;
      best = hit.result;
      pins = [...hit.pins];
    }
  }
  return { result: best, runs, before, after: cost(best) };
}

/**
 * Runs the program once per seed (from scratch each time) and stops at the first run `check`
 * rejects. `check` returns true to pass, or false / a reason to fail; by default a run passes when
 * main ended with a value. Rerun the reported seed (and strategy) with Sim.run to get the same
 * trace back, or replay result.choices. The failing run is then shrunk to a minimal schedule
 * (`shrunk`), unless `shrink: false`.
 */
export function explore<A, S extends Row, W extends World<S> = World<S>>(
  program: Kyoot<A, S> & Simulable<S>,
  options: Omit<RunOptions<S, W>, "seed"> & {
    readonly seeds: number | Iterable<number>;
    readonly check?: Check<A, FailOf<S>, W>;
    readonly shrink?: boolean;
  },
): Explored<A, FailOf<S>, W> {
  const { seeds, check, shrink: doShrink = true } = options;
  const list = typeof seeds === "number" ? Array.from({ length: seeds }, (_, i) => i) : seeds;
  let runs = 0;
  for (const seed of list) {
    runs++;
    const result = run(program, { ...options, seed } as RunOptions<S, W>);
    const verdict = verdictOf(check, result);
    if (verdict !== true) {
      const reason = verdict === false ? `check failed: ${showExit(result.exit)}` : verdict;
      const found = { ok: false, runs, seed, strategy: result.strategy, reason, result } as const;
      if (!doShrink) return found;
      return { ...found, shrunk: shrink(program, result, options as ShrinkOptions<S, W>) };
    }
  }
  return { ok: true, runs };
}
