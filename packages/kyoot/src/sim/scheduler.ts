import * as Fail from "../effects/fail.ts";
import type { Err } from "../effects/fail.ts";
import type { Kyoot } from "../model.ts";
import { step } from "../step.ts";
import type { Answer, Only, Payload, Row } from "../types.ts";
import type { ConcurrencyKey, Exit, Fiber, ForkRequest } from "../async/effects.ts";
import { guarded } from "./guard.ts";
import { prng, random, type Strategy } from "./strategy.ts";

export type Stuck =
  | { readonly _tag: "Deadlock"; readonly blocked: ReadonlyArray<string> }
  | { readonly _tag: "StepLimit"; readonly steps: number };

export type SimExit<E, A> = Exit<E, A> | Err<Stuck>;

export interface TraceEvent {
  readonly time: number;
  readonly fiber: string;
  readonly what: string;
}

// A world answer that arrives after some virtual time (the request itself happened at once).
export class Delayed<A> {
  readonly ms: number;
  readonly answer: A;
  constructor(ms: number, answer: A) {
    this.ms = ms;
    this.answer = answer;
  }
}

export const delay = <A>(ms: number, answer: A) => new Delayed(ms, answer);

// A world answer that fails with the program's typed error instead of answering.
export class Failed<E> {
  readonly error: E;
  constructor(error: E) {
    this.error = error;
  }
}

export const fail = <E>(error: E) => new Failed(error);

export interface WorldContext {
  readonly now: number;
  readonly fiber: string;
  // Seeded, and separate from the scheduler's stream: use it for fault injection.
  random(): number;
}

// Keys the scheduler answers itself. "fail" ends a fiber with a typed failure, and "async" (promise
// interop) can't run in a simulation at all.
type Reserved = ConcurrencyKey | "random" | "fail" | "async";

// The world answers an effect for every fiber, so it also satisfies the "fork/<key>" markers of
// effects a forked fiber leaves unhandled.
type Unmarked<S> = { [K in keyof S as K extends `fork/${infer X}` ? X : K]: S[K] };

export type WorldKeysOf<S> = Exclude<keyof Unmarked<S>, Reserved> & string;

// What Sim.run accepts: anything but promise interop. Declare an effect for that I/O instead.
export type Simulable<S extends Row> = Only<S, Exclude<keyof S, "async">>;

// One responder per effect the program leaves to the outside world, whatever its key (db/get,
// fs/readFile, ai/model). It answers synchronously, may answer later with delay(), or throw to
// raise the error at the fiber's operation. In production, ordinary handlers answer the same keys.
// The answer, or Sim.fail(e): the effect's declared failure, which surfaces in the fiber that
// performed it. Typed loosely, because failures live per fiber (a forked child's aren't in the row).
type WorldAnswer<S, K extends string> = Answer<Unmarked<S>, K> | Failed<unknown>;

export type World<S> = {
  readonly [K in WorldKeysOf<S>]: (
    payload: Payload<Unmarked<S>, K>,
    ctx: WorldContext,
  ) => WorldAnswer<S, K> | Delayed<WorldAnswer<S, K>>;
};

type WorldOption<S, W> = [WorldKeysOf<S>] extends [never]
  ? { readonly world?: () => W }
  : { readonly world: () => W };

export type RunOptions<S, W> = {
  // Seeds the strategy and the world's random().
  readonly seed: number;
  // Who runs next (default: Sim.random()). Sim.replay(choices) reruns a recorded schedule.
  readonly strategy?: Strategy;
  // Scheduling decisions before giving up with StepLimit (a livelock guard).
  readonly maxSteps?: number;
  // While it runs, Date.now, Math.random, timers, fetch and crypto randomness throw (they would
  // break determinism). Default true; false lets them through.
  readonly guard?: boolean;
} & WorldOption<S, W>;

export interface SimResult<A, E, W> {
  readonly seed: number;
  readonly strategy: string;
  // The scheduler's choice at each step (an index into the runnable fibers): Sim.replay(choices).
  readonly choices: ReadonlyArray<number>;
  // The fiber id that ran at each step, and how many of those steps switched away from a fiber that
  // could have kept running (the preemptions; switching because it blocked is free).
  readonly schedule: ReadonlyArray<number>;
  readonly preemptions: number;
  readonly exit: SimExit<E, A>;
  readonly trace: ReadonlyArray<TraceEvent>;
  readonly now: number;
  readonly steps: number;
  readonly world: W;
}

export type FailOf<S> = Payload<S, "fail">;

type Next =
  | { readonly kind: "start" }
  | { readonly kind: "resume"; readonly value: unknown }
  | { readonly kind: "raise"; readonly error: unknown }
  | { readonly kind: "fail"; readonly error: unknown }
  | { readonly kind: "cancel" };

type Status = "runnable" | "running" | "sleeping" | "joining" | "draining" | "done";

type AnyStep =
  | { readonly done: true; readonly value: unknown }
  | {
      readonly done: false;
      readonly key: PropertyKey;
      readonly payload: unknown;
      resume(value: unknown): AnyStep;
      resumeWith(program: Kyoot<unknown, any>): AnyStep;
      raise(error: unknown): AnyStep;
      cancel(): AnyStep;
    };

type PendingStep = Extract<AnyStep, { done: false }>;

interface FiberState {
  readonly handle: Fiber<unknown, unknown>;
  readonly program: Kyoot<unknown, any>;
  readonly parent: FiberState | undefined;
  readonly children: Set<FiberState>;
  readonly joiners: Array<{ readonly fiber: FiberState; readonly answer: "exit" | "void" }>;
  status: Status;
  next: Next;
  pending: PendingStep | undefined;
  interrupting: boolean;
  until: number;
  waitingOn: FiberState | undefined;
  exit: Exit<unknown, unknown> | undefined;
}

const INTERRUPTED: Exit<never, never> = { ok: false, cause: { _tag: "Interrupted" } };

/**
 * Runs a program and every fiber it forks on one thread, with a seeded scheduler.
 *
 * - Every effect a fiber performs is a scheduling point: the fiber goes back to the runnable set and
 *   the seed picks who runs next. Nothing else decides order, so a seed is a replayable schedule.
 * - Time is virtual: it only moves when no fiber can run, straight to the next sleeper's deadline.
 * - Nothing runnable and nobody sleeping, but main is not done: a Deadlock, reported with what each
 *   fiber waits on.
 * - Structured concurrency: when a fiber's body ends (value, failure, defect or interrupt, after its
 *   own finalizers), its unfinished children are interrupted, and the fiber counts as done (for
 *   join and interrupt) only once all of them are. Interrupting a fiber cancels its pending step,
 *   which runs its finally blocks and ensuring cleanups; those may perform effects as usual.
 *
 * Determinism contract: the program may reach time, randomness and I/O only through effects
 * (clock/*, random, and effects the world answers). While the run executes, Date.now, performance.now,
 * Math.random, timers, fetch and crypto randomness throw (see `guard`; this covers the run, not
 * module-level code). The whole program runs from scratch on every call, so state created
 * inside it (a variable in a generator, the world from `world()`) is fresh per run.
 */
export function run<A, S extends Row, W extends World<S> = World<S>>(
  program: Kyoot<A, S> & Simulable<S>,
  options: RunOptions<S, W>,
): SimResult<A, FailOf<S>, W> {
  return options.guard === false
    ? simulate(program, options)
    : guarded(() => simulate(program, options));
}

function simulate<A, S extends Row, W extends World<S> = World<S>>(
  program: Kyoot<A, S> & Simulable<S>,
  options: RunOptions<S, W>,
): SimResult<A, FailOf<S>, W> {
  const { seed, maxSteps = 100_000, strategy = random() } = options;
  const pick = strategy.chooser(seed);
  const choices: number[] = [];
  const ran: number[] = [];
  let preemptions = 0;
  let last: number | undefined;
  const chance = prng(seed ^ 0x5bd1e995);
  const world = (options.world?.() ?? {}) as W;
  const responders = world as unknown as Record<string, unknown>;
  const trace: TraceEvent[] = [];
  const runnable: FiberState[] = [];
  const fibers: FiberState[] = [];
  let now = 0;
  let steps = 0;

  const log = (f: FiberState, what: string) =>
    trace.push({ time: now, fiber: f.handle.name, what });

  const spawn = (program: Kyoot<unknown, any>, parent?: FiberState, name?: string) => {
    const id = fibers.length;
    const f: FiberState = {
      handle: { id, name: name ?? (parent === undefined ? "main" : `#${id}`) },
      program,
      parent,
      children: new Set(),
      joiners: [],
      status: "runnable",
      next: { kind: "start" },
      pending: undefined,
      interrupting: false,
      until: 0,
      waitingOn: undefined,
      exit: undefined,
    };
    fibers.push(f);
    parent?.children.add(f);
    runnable.push(f);
    return f;
  };

  const schedule = (f: FiberState, next: Next) => {
    f.next = next;
    f.status = "runnable";
    f.waitingOn = undefined;
    runnable.push(f);
  };

  const complete = (f: FiberState) => {
    f.status = "done";
    log(f, `done: ${showExit(f.exit!)}`);
    for (const j of f.joiners) {
      if (j.fiber.status === "joining" && j.fiber.waitingOn === f) {
        schedule(j.fiber, { kind: "resume", value: j.answer === "exit" ? f.exit : undefined });
      }
    }
    const parent = f.parent;
    if (parent === undefined) return;
    parent.children.delete(f);
    if (parent.status === "draining" && parent.children.size === 0) complete(parent);
  };

  // The body ended; children go first (structured concurrency), then the fiber completes.
  const finish = (f: FiberState, exit: Exit<unknown, unknown>) => {
    f.exit = f.interrupting ? INTERRUPTED : exit;
    f.pending = undefined;
    if (f.children.size === 0) return complete(f);
    f.status = "draining";
    for (const child of f.children) requestInterrupt(child);
  };

  const requestInterrupt = (t: FiberState) => {
    if (t.interrupting || t.status === "done" || t.status === "draining") return;
    t.interrupting = true;
    if (t.next.kind === "start") {
      runnable.splice(runnable.indexOf(t), 1);
      finish(t, INTERRUPTED);
      return;
    }
    if (t.status === "running") {
      t.next = { kind: "cancel" };
      return;
    }
    if (t.status === "runnable") runnable.splice(runnable.indexOf(t), 1);
    schedule(t, { kind: "cancel" });
  };

  const join = (f: FiberState, target: FiberState, answer: "exit" | "void") => {
    if (target.status === "done") {
      return schedule(f, { kind: "resume", value: answer === "exit" ? target.exit : undefined });
    }
    f.status = "joining";
    f.waitingOn = target;
    target.joiners.push({ fiber: f, answer });
  };

  const fiberOf = (handle: Fiber<unknown, unknown> | undefined) => {
    const f = handle === undefined ? undefined : fibers[handle.id];
    if (f === undefined) throw new Error(`sim: not a fiber: ${show(handle)}`);
    return f;
  };

  const answer = (f: FiberState, key: string, payload: unknown) => {
    try {
      perform(f, key, payload);
    } catch (error) {
      schedule(f, { kind: "raise", error });
    }
  };

  const perform = (f: FiberState, key: string, payload: unknown) => {
    switch (key) {
      case "fiber/fork": {
        const req = payload as ForkRequest;
        const child = spawn(req.program, f, req.name);
        log(f, `fork ${child.handle.name}`);
        return schedule(f, { kind: "resume", value: child.handle });
      }
      case "fiber/join": {
        const target = fiberOf(payload as Fiber<unknown, unknown>);
        log(f, `join ${target.handle.name}`);
        return join(f, target, "exit");
      }
      case "fiber/interrupt": {
        const target = payload === undefined ? f : fiberOf(payload as Fiber<unknown, unknown>);
        log(f, `interrupt ${target.handle.name}`);
        if (target === f) {
          requestInterrupt(f);
          return schedule(f, f.next);
        }
        requestInterrupt(target);
        return join(f, target, "void");
      }
      case "fiber/yield":
        return schedule(f, { kind: "resume", value: undefined });
      case "clock/sleep": {
        const ms = Math.max(0, payload as number);
        f.status = "sleeping";
        f.until = now + ms;
        f.next = { kind: "resume", value: undefined };
        return log(f, `sleep ${showTime(ms)}`);
      }
      case "clock/now":
        return schedule(f, { kind: "resume", value: now });
      case "random": {
        const x = chance();
        log(f, `random → ${x.toFixed(3)}`);
        return schedule(f, { kind: "resume", value: x });
      }
    }
    if (key === "async") {
      log(f, "async ✗");
      const error = new Error(
        `sim: promise interop (Async.fromPromise) can't run in a simulation (fiber ${f.handle.name}); declare an effect for it and answer it from the world`,
      );
      return schedule(f, { kind: "raise", error });
    }
    const responder = responders[key];
    if (typeof responder !== "function") {
      log(f, `unhandled ${key}`);
      const error = new Error(`sim: no handler for effect '${key}' in fiber ${f.handle.name}`);
      return schedule(f, { kind: "raise", error });
    }
    let result: unknown;
    try {
      result = (responder as (p: unknown, ctx: WorldContext) => unknown)(payload, {
        now,
        fiber: f.handle.name,
        random: chance,
      });
    } catch (error) {
      log(f, `${key}${showPayload(payload)} ✗ ${show(error)}`);
      return schedule(f, { kind: "raise", error });
    }
    const after = result instanceof Delayed ? result.ms : 0;
    const answered = result instanceof Delayed ? result.answer : result;
    const next: Next =
      answered instanceof Failed
        ? { kind: "fail", error: answered.error }
        : { kind: "resume", value: answered };
    const later = result instanceof Delayed ? ` (in ${showTime(after)})` : "";
    const what =
      answered instanceof Failed
        ? ` ✗${later} fail ${show(answered.error)}`
        : answered === undefined && later === ""
          ? ""
          : ` →${later} ${show(answered)}`;
    if (result instanceof Delayed) {
      log(f, `${key}${showPayload(payload)}${what}`);
      f.status = "sleeping";
      f.until = now + after;
      f.next = next;
      return;
    }
    log(f, `${key}${showPayload(payload)}${what}`);
    schedule(f, next);
  };

  const advance = (f: FiberState) => {
    f.status = "running";
    const next = f.next;
    let s: AnyStep;
    try {
      if (next.kind === "start") {
        s = step(Fail.run(f.program as Kyoot<unknown, Row>)) as unknown as AnyStep;
      } else {
        const pending = f.pending!;
        f.pending = undefined;
        s =
          next.kind === "resume"
            ? pending.resume(next.value)
            : next.kind === "raise"
              ? pending.raise(next.error)
              : next.kind === "fail"
                ? pending.resumeWith(Fail.fail(next.error) as Kyoot<unknown, any>)
                : pending.cancel();
      }
    } catch (defect) {
      return finish(f, { ok: false, cause: { _tag: "Defect", defect } });
    }
    if (s.done) return finish(f, s.value as Exit<unknown, unknown>);
    f.pending = s;
    answer(f, String(s.key), s.payload);
  };

  const main = spawn(program as Kyoot<unknown, any>);
  const result = (exit: SimExit<unknown, unknown>): SimResult<A, FailOf<S>, W> => ({
    seed,
    strategy: strategy.name,
    choices,
    schedule: ran,
    preemptions,
    exit: exit as SimExit<FailOf<S>, A>,
    trace,
    now,
    steps,
    world,
  });

  while (main.status !== "done") {
    if (runnable.length === 0) {
      const sleepers = fibers.filter((f) => f.status === "sleeping");
      if (sleepers.length === 0) {
        const blocked = fibers.filter((f) => f.status !== "done").map(describe);
        return result({ ok: false, cause: { _tag: "Deadlock", blocked } });
      }
      now = Math.min(...sleepers.map((f) => f.until));
      for (const f of sleepers) if (f.until <= now) schedule(f, f.next);
      continue;
    }
    if (++steps > maxSteps) return result({ ok: false, cause: { _tag: "StepLimit", steps } });
    const ids = runnable.map((r) => r.handle.id);
    const choice = pick(ids, choices.length);
    choices.push(choice);
    const chosen = ids[choice]!;
    if (last !== undefined && chosen !== last && ids.includes(last)) preemptions++;
    ran.push(chosen);
    last = chosen;
    const [f] = runnable.splice(choice, 1);
    advance(f!);
  }
  return result(main.exit!);
}

const describe = (f: FiberState): string => {
  const name = f.handle.name;
  switch (f.status) {
    case "joining":
      return `${name} waits for ${f.waitingOn!.handle.name}`;
    case "draining":
      return `${name} waits for its children ${[...f.children].map((c) => c.handle.name).join(", ")}`;
    default:
      return `${name} is ${f.status}`;
  }
};

export const showTime = (ms: number): string => {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${+(ms / 1_000).toFixed(3)}s`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = +((ms % 60_000) / 1_000).toFixed(3);
  const ss = `${s < 10 ? "0" : ""}${s}s`;
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m${ss}` : `${m}m${ss}`;
};

const show = (v: unknown): string => {
  if (v instanceof Error) return v.message;
  if (typeof v === "object" && v !== null && "_tag" in v && Object.keys(v).length <= 2) {
    const rest = Object.entries(v).filter(([k]) => k !== "_tag");
    return rest.length === 0 ? String(v._tag) : `${String(v._tag)}(${show(rest[0]![1])})`;
  }
  const text = typeof v === "function" ? "<function>" : (JSON.stringify(v) ?? String(v));
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
};

const showPayload = (payload: unknown) => (payload === undefined ? "" : ` ${show(payload)}`);

export const showExit = (exit: SimExit<unknown, unknown>): string => {
  if (exit.ok) return exit.value === undefined ? "ok" : `ok ${show(exit.value)}`;
  const cause = exit.cause;
  switch (cause._tag) {
    case "Fail":
      return `fail ${show(cause.error)}`;
    case "Defect":
      return `defect ${show(cause.defect)}`;
    case "Interrupted":
      return "interrupted";
    case "Deadlock":
      return `deadlock (${cause.blocked.join("; ")})`;
    case "StepLimit":
      return `gave up after ${cause.steps} steps`;
  }
};

// One line per event: virtual time (left out when it never moved), fiber, what it did. Consecutive
// events of one fiber show its name once (collapse: false repeats it).
export const format = (
  trace: ReadonlyArray<TraceEvent>,
  options: { readonly collapse?: boolean } = {},
): string => {
  const { collapse = true } = options;
  const width = Math.max(0, ...trace.map((e) => e.fiber.length));
  const timed = trace.some((e) => e.time > 0);
  const times = trace.map((e) => (timed ? showTime(e.time) : ""));
  const tw = Math.max(0, ...times.map((t) => t.length));
  return trace
    .map((e, i) => {
      const same = collapse && i > 0 && trace[i - 1]!.fiber === e.fiber;
      return `${timed ? `${times[i]!.padStart(tw)}  ` : ""}${(same ? "" : e.fiber).padEnd(width)}  ${e.what}`;
    })
    .join("\n");
};
