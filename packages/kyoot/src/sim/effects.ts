import { gen, makeOp, succeed } from "../core.ts";
import { fail, type Err, type FailRow, type Result } from "../effects/fail.ts";
import type { Kyoot } from "../model.ts";
import type { Answer, MergeAll, Only, Op, Payload, Row } from "../types.ts";

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

// Every concurrency operation is an ordinary effect with a data payload. Whoever drives the program
// (Sim.run here, a live runtime later) sees and answers them one at a time.
export type SimRow = {
  "fiber/fork": Op<ForkRequest, Fiber<unknown, unknown>>;
  "fiber/join": Op<Fiber<unknown, unknown>, Exit<unknown, unknown>>;
  "fiber/interrupt": Op<Fiber<unknown, unknown>, void>;
  "fiber/yield": Op<void, void>;
  "clock/sleep": Op<number, void>;
  "clock/now": Op<void, number>;
};

export type SimKey = keyof SimRow;

// Effects whose key starts with io/ are the outside world: Sim.run answers them from a scripted World.
export type IoKey = `io/${string}`;

// What a forked program may still need: sim effects, typed failures, the world, and the existing
// "clock" and "random" effects (Sim answers those too, from virtual time and the seed).
export type ChildKey = SimKey | IoKey | "fail" | "clock" | "random";

// A child's world effects (and random/clock) surface in the parent's row, so Sim.run checks the
// world covers every io/ key any fiber performs.
type Bubbled<S> = Pick<S, Extract<keyof S, IoKey | "random" | "clock">>;

type FailOf<S> = Payload<S, "fail">;

const perform = <K extends SimKey>(key: K, payload: Payload<SimRow, K>) =>
  makeOp(key, payload) as Kyoot<Answer<SimRow, K>, Pick<SimRow, K>>;

export const fork = <A, S extends Row>(
  program: Kyoot<A, S> & Only<S, ChildKey>,
  options: { readonly name?: string } = {},
): Kyoot<Fiber<A, FailOf<S>>, MergeAll<Pick<SimRow, "fiber/fork"> | Bubbled<S>>> =>
  perform("fiber/fork", { program, name: options.name }) as never;

// Waits for the fiber and answers with its exit, whatever it was.
export const wait = <A, E>(fiber: Fiber<A, E>) =>
  perform("fiber/join", fiber) as Kyoot<Exit<E, A>, Pick<SimRow, "fiber/join">>;

export class FiberInterrupted extends Error {
  readonly _tag = "FiberInterrupted";
  constructor(name: string) {
    super(`joined fiber ${name} was interrupted`);
    this.name = "FiberInterrupted";
  }
}

const fromExit = <E, A>(exit: Exit<E, A>, name: string): Kyoot<A, FailRow<E>> => {
  if (exit.ok) return succeed(exit.value);
  switch (exit.cause._tag) {
    case "Fail":
      return fail(exit.cause.error) as never;
    case "Defect":
      throw exit.cause.defect;
    case "Interrupted":
      throw new FiberInterrupted(name);
  }
};

// Waits for the fiber and continues as it ended: its value, its typed failure (re-failed here), its
// defect (re-thrown here), or FiberInterrupted (thrown) if it was interrupted.
export const join = <A, E>(
  fiber: Fiber<A, E>,
): Kyoot<A, MergeAll<Pick<SimRow, "fiber/join"> | FailRow<E>>> =>
  wait(fiber).flatMap((exit) => fromExit(exit, fiber.name)) as never;

// Interrupts the fiber and waits until its finalizers have run. A no-op on a finished fiber.
export const interrupt = (fiber: Fiber<unknown, unknown>) => perform("fiber/interrupt", fiber);

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

type Ops<K extends SimKey> = Pick<SimRow, K>;

// Built only from fork, wait, sleep and interrupt: the program runs in a child while a timer child
// sleeps and then interrupts it. Fails with Timeout if the timer won.
export const timeout = <A, S extends Row>(
  ms: number,
  program: Kyoot<A, S> & Only<S, ChildKey>,
  options: { readonly name?: string } = {},
): Kyoot<
  A,
  MergeAll<
    | Ops<"fiber/fork" | "fiber/join" | "fiber/interrupt" | "clock/sleep">
    | Bubbled<S>
    | FailRow<FailOf<S> | Timeout>
  >
> =>
  gen(function* () {
    let fired = false;
    const work = yield* fork(program as never, options);
    const timer = yield* fork(
      gen(function* () {
        yield* sleep(ms);
        fired = true;
        yield* interrupt(work);
      }),
      { name: `${work.name}.timer` },
    );
    const exit = yield* wait(work);
    yield* interrupt(timer);
    if (fired && !exit.ok && exit.cause._tag === "Interrupted") return yield* fail(new Timeout(ms));
    return yield* fromExit(exit, work.name);
  }) as never;

// Runs every program in its own fiber and collects the values in order. The first failure (in
// order of the list) interrupts the rest and is re-raised here.
export const all = <A, S extends Row>(
  programs: ReadonlyArray<Kyoot<A, S> & Only<S, ChildKey>>,
  options: { readonly names?: ReadonlyArray<string> } = {},
): Kyoot<
  A[],
  MergeAll<Ops<"fiber/fork" | "fiber/join" | "fiber/interrupt"> | Bubbled<S> | FailRow<FailOf<S>>>
> =>
  gen(function* () {
    const fibers: Fiber<unknown, unknown>[] = [];
    for (const [i, program] of programs.entries()) {
      fibers.push(yield* fork(program as never, { name: options.names?.[i] }));
    }
    const values: unknown[] = [];
    for (const fiber of fibers) {
      const exit = yield* wait(fiber);
      if (!exit.ok) {
        for (const other of fibers) yield* interrupt(other);
        return yield* fromExit(exit, fiber.name);
      }
      values.push(exit.value);
    }
    return values;
  }) as never;
