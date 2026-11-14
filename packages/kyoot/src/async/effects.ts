import { gen, makeIntercept, makeOp, succeed } from "../core.ts";
import * as Fail from "../effects/fail.ts";
import type { Err, FailRow, Result } from "../effects/fail.ts";
import type { AnyKyoot, Kyoot } from "../model.ts";
import type { Answer, MergeAll, Op, Payload, Row } from "../types.ts";

// Concurrency as plain-data effects. A program forks, joins, interrupts and sleeps by performing
// these; whoever drives it answers them: runPromise with real fibers and timers, Sim.run with a
// seeded scheduler and virtual time. The program is the same either way.

// A fiber is a plain handle. The phantom fields keep join's answer and failure typed.
export interface Fiber<A, E = never> {
  readonly id: number;
  readonly name: string;
  readonly _A?: A;
  readonly _E?: E;
}

export type Interrupted = { readonly _tag: "Interrupted" };

export type Exit<E, A> = Result<E, A> | Err<Interrupted>;

export interface ForkRequest {
  readonly program: Kyoot<unknown, any>;
  readonly name: string | undefined;
}

export type ConcurrencyRow = {
  "fiber/fork": Op<ForkRequest, Fiber<unknown, unknown>>;
  "fiber/join": Op<Fiber<unknown, unknown>, Exit<unknown, unknown>>;
  // No fiber: interrupt the fiber performing it.
  "fiber/interrupt": Op<Fiber<unknown, unknown> | undefined, void>;
  "fiber/yield": Op<void, void>;
  "clock/sleep": Op<number, void>;
  "clock/now": Op<void, number>;
};

export type ConcurrencyKey = keyof ConcurrencyRow;

type Ops<K extends ConcurrencyKey> = Pick<ConcurrencyRow, K>;

// A forked fiber's typed failure becomes its Exit; everything else it leaves unhandled surfaces in
// the parent's row, because the driver answers it for every fiber (handlers don't cross a fork).
export type Bubbled<S> = S extends unknown ? Omit<S, "fail"> : never;

export type FailOf<S> = Payload<S, "fail">;

const perform = <K extends ConcurrencyKey>(key: K, payload: Payload<ConcurrencyRow, K>) =>
  makeOp(key, payload) as Kyoot<Answer<ConcurrencyRow, K>, Ops<K>>;

type Provider = (k: any) => AnyKyoot;

const provided = (k: AnyKyoot, provide: Provider | undefined): AnyKyoot =>
  provide === undefined ? k : provide(k);

// `provide` installs handlers in the child, e.g. `{ provide: (k) => k.pipe(clock.handler) }`.
export function fork<A, S extends Row, B, S2 extends Row>(
  program: Kyoot<A, S>,
  options: { readonly name?: string; readonly provide: (k: Kyoot<A, S>) => Kyoot<B, S2> },
): Kyoot<Fiber<B, FailOf<S2>>, MergeAll<Ops<"fiber/fork"> | Bubbled<S2>>>;
export function fork<A, S extends Row>(
  program: Kyoot<A, S>,
  options?: { readonly name?: string },
): Kyoot<Fiber<A, FailOf<S>>, MergeAll<Ops<"fiber/fork"> | Bubbled<S>>>;
export function fork(
  program: AnyKyoot,
  options: { readonly name?: string; readonly provide?: Provider } = {},
): AnyKyoot {
  return perform("fiber/fork", { program: provided(program, options.provide), name: options.name });
}

// Waits for the fiber and answers with its exit, whatever it was.
export const wait = <A, E>(fiber: Fiber<A, E>) =>
  perform("fiber/join", fiber) as Kyoot<Exit<E, A>, Ops<"fiber/join">>;

// Interrupts the fiber and waits until its finalizers have run. A no-op on a finished fiber.
export const interrupt = (fiber: Fiber<unknown, unknown>) => perform("fiber/interrupt", fiber);

const interruptSelf = perform("fiber/interrupt", undefined) as Kyoot<never, Ops<"fiber/interrupt">>;

// Continues as the exit says: its value, its typed failure (re-failed here), its defect (re-thrown
// here). An interrupted exit interrupts the fiber that reads it.
export const fromExit = <E, A>(
  exit: Exit<E, A>,
): Kyoot<A, MergeAll<FailRow<E> | Ops<"fiber/interrupt">>> => {
  if (exit.ok) return succeed(exit.value);
  switch (exit.cause._tag) {
    case "Fail":
      return Fail.fail(exit.cause.error) as never;
    case "Defect":
      throw exit.cause.defect;
    case "Interrupted":
      return interruptSelf as never;
  }
};

// Waits for the fiber and continues as it ended (see fromExit).
export const join = <A, E>(
  fiber: Fiber<A, E>,
): Kyoot<A, MergeAll<Ops<"fiber/join" | "fiber/interrupt"> | FailRow<E>>> =>
  wait(fiber).flatMap(fromExit) as never;

export const yieldNow = perform("fiber/yield", undefined);

export const sleep = (ms: number) => perform("clock/sleep", ms);

export const now = perform("clock/now", undefined);

export class Timeout {
  readonly _tag = "Timeout";
  readonly ms: number;
  constructor(ms: number) {
    this.ms = ms;
  }
}

type Spawning = Ops<"fiber/fork" | "fiber/join" | "fiber/interrupt">;

type Outcome = Result<unknown, unknown>;

const caught = (k: AnyKyoot) => Fail.run(k) as Kyoot<Outcome, {}>;

// Forks every program; the first to end (with a value, a failure or a defect) wins and interrupts
// the rest. Answers once every loser's finalizers have run.
const first = (
  programs: ReadonlyArray<AnyKyoot>,
  names: ReadonlyArray<string | undefined> | undefined,
  provide: Provider | undefined,
) =>
  gen(function* () {
    let winner: Outcome | undefined;
    const fibers: Fiber<unknown, unknown>[] = [];
    const settle = (i: number) => (r: Outcome) =>
      gen(function* () {
        if (winner !== undefined) return;
        winner = r;
        for (const [j, f] of fibers.entries()) if (j !== i) yield* interrupt(f);
      });
    for (const [i, program] of programs.entries()) {
      if (winner !== undefined) break;
      const body = caught(provided(program, provide)).flatMap(settle(i));
      fibers.push(yield* fork(body, { name: names?.[i] }));
    }
    if (winner !== undefined) for (const f of fibers) yield* interrupt(f);
    for (const f of fibers) yield* wait(f);
    if (winner === undefined) return yield* interruptSelf;
    return yield* Fail.fromResult(winner);
  });

type RaceOptions = { readonly names?: ReadonlyArray<string> };

export function race<A, B, S1 extends Row, S2 extends Row, C, S3 extends Row>(
  a: Kyoot<A, S1>,
  b: Kyoot<B, S2>,
  options: RaceOptions & {
    readonly provide: (k: Kyoot<A | B, MergeAll<S1 | S2>>) => Kyoot<C, S3>;
  },
): Kyoot<C, MergeAll<Spawning | Bubbled<S3> | FailRow<FailOf<S3>>>>;
export function race<A, B, S1 extends Row, S2 extends Row>(
  a: Kyoot<A, S1>,
  b: Kyoot<B, S2>,
  options?: RaceOptions,
): Kyoot<A | B, MergeAll<Spawning | Bubbled<S1> | Bubbled<S2> | FailRow<FailOf<S1> | FailOf<S2>>>>;
export function race(
  a: AnyKyoot,
  b: AnyKyoot,
  options: RaceOptions & { readonly provide?: Provider } = {},
): AnyKyoot {
  return first([a, b], options.names, options.provide);
}

type AllOptions = { readonly concurrency?: number; readonly names?: ReadonlyArray<string> };

// Runs the programs concurrently (at most `concurrency` at a time) and answers their values in input
// order. The first to fail or die interrupts the rest, and that failure is re-raised here.
export function all<A, S extends Row, B, S2 extends Row>(
  programs: ReadonlyArray<Kyoot<A, S>>,
  options: AllOptions & { readonly provide: (k: Kyoot<A, S>) => Kyoot<B, S2> },
): Kyoot<B[], MergeAll<Spawning | Bubbled<S2> | FailRow<FailOf<S2>>>>;
export function all<A, S extends Row = {}>(
  programs: ReadonlyArray<Kyoot<A, S>>,
  options?: AllOptions,
): Kyoot<A[], MergeAll<Spawning | Bubbled<S> | FailRow<FailOf<S>>>>;
export function all(
  programs: ReadonlyArray<AnyKyoot>,
  options: AllOptions & { readonly provide?: Provider } = {},
): AnyKyoot {
  return gen(function* () {
    const n = programs.length;
    if (n === 0) return [];
    const limit = options.concurrency ?? n;
    const workers = Math.min(n, Math.max(1, Number.isNaN(limit) ? n : Math.floor(limit)));
    const values: unknown[] = new Array(n);
    const fibers: Fiber<unknown, unknown>[] = [];
    let next = workers;
    let stopped: Outcome | undefined;
    // Worker w runs item w first, then whatever is next.
    const worker = (w: number) =>
      gen(function* () {
        for (let i = w; stopped === undefined && i < n; i = next++) {
          const r = yield* caught(provided(programs[i]!, options.provide));
          if (r.ok) {
            values[i] = r.value;
            continue;
          }
          if (stopped !== undefined) return;
          stopped = r;
          for (const [j, f] of fibers.entries()) if (j !== w) yield* interrupt(f);
        }
      });
    for (let w = 0; w < workers && stopped === undefined; w++) {
      fibers.push(yield* fork(worker(w), { name: options.names?.[w] }));
    }
    if (stopped !== undefined) for (const f of fibers) yield* interrupt(f);
    let interrupted = false;
    for (const f of fibers) interrupted = !(yield* wait(f)).ok || interrupted;
    if (stopped !== undefined) return yield* Fail.fromResult(stopped);
    if (interrupted) return yield* interruptSelf;
    return values;
  });
}

type TimeoutOptions = { readonly name?: string };

type Sleeper = Ops<"clock/sleep"> | FailRow<Timeout>;

// Races the program against a sleep that fails with Timeout. Built only from the effects above, so
// it runs on real time under runPromise and on virtual time under Sim.run. With `provide`, both the
// program and the sleep are wrapped (e.g. in a test clock).
export function timeout<A, S extends Row, C, S2 extends Row>(
  ms: number,
  program: Kyoot<A, S>,
  options: TimeoutOptions & {
    readonly provide: (k: Kyoot<A, MergeAll<S | Sleeper>>) => Kyoot<C, S2>;
  },
): Kyoot<C, MergeAll<Spawning | Bubbled<S2> | FailRow<FailOf<S2>>>>;
export function timeout<A, S extends Row>(
  ms: number,
  program: Kyoot<A, S>,
  options?: TimeoutOptions,
): Kyoot<A, MergeAll<Spawning | Ops<"clock/sleep"> | Bubbled<S> | FailRow<FailOf<S> | Timeout>>>;
export function timeout(
  ms: number,
  program: AnyKyoot,
  options: TimeoutOptions & { readonly provide?: Provider } = {},
): AnyKyoot {
  const timer = sleep(ms).flatMap(() => Fail.fail(new Timeout(ms)));
  const { name } = options;
  return first(
    [program, timer],
    name === undefined ? undefined : [name, `${name}.timer`],
    options.provide,
  );
}

const inheritFork = makeIntercept<"fiber/fork", ForkRequest, Fiber<unknown, unknown>>("fiber/fork");

/**
 * Handles a program and every fiber it forks (and they fork) with the same handler. A plain
 * handler only reaches the fiber it wraps; this one also wraps each fork's program, by intercepting
 * fiber/fork. Use it to install live services (or in-memory fakes) once for a whole program. The
 * handler should keep the program's value (a service, not Log.collect), since forks are typed by it:
 *   runPromise(program.pipe(Async.provide(Node.provide)))
 */
export const provide = <Args extends [Kyoot<any, any>], R>(
  handler: (...args: Args) => R,
): ((...args: Args) => R) => {
  const h = handler as unknown as (k: AnyKyoot) => AnyKyoot;
  const inherit = inheritFork((req, next) => next({ ...req, program: wrap(req.program) }));
  const wrap = (k: AnyKyoot): AnyKyoot => h(inherit(k));
  return wrap as never;
};
