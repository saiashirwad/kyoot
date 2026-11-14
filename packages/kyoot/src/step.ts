import { node } from "./core.ts";
import { Machine, type Outcome } from "./machine.ts";
import type { AnyKyoot, Kyoot } from "./model.ts";
import type { Answer, Only, Payload, Row } from "./types.ts";

export interface Done<A> {
  readonly done: true;
  readonly value: A;
}

export interface Yielded<A, S extends Row> extends Disposable {
  readonly done: false;
  readonly yielded: true;
  continue(): Step<A, S, true>;
  cancel(): Step<undefined, S, true>;
}

interface PendingAt<A, S extends Row, K extends keyof S, B extends boolean> extends Disposable {
  readonly done: false;
  readonly yielded?: false;
  readonly key: K;
  readonly payload: Payload<S, K>;
  resume(value: Answer<S, K>): Step<A, S, B>;
  raise(error: unknown): Step<A, S, B>;
  cancel(): Step<undefined, S, B>;
}

export type Pending<A, S extends Row, B extends boolean = false> = {
  [K in keyof S]: PendingAt<A, S, K, B>;
}[keyof S];

export type Step<A, S extends Row = {}, B extends boolean = false> =
  | Done<A>
  | Pending<A, S, B>
  | (B extends true ? Yielded<A, S> : never);

export interface StepOptions {
  /** Machine steps per run before the step reports `yielded`. */
  readonly budget: number;
}

type AnyStep = Done<unknown> | Suspended | Halted;

abstract class Held implements Disposable {
  readonly done = false;
  private machine: Machine | undefined;
  private readonly budget: number;

  constructor(machine: Machine, budget: number) {
    this.machine = machine;
    this.budget = budget;
  }

  resume(value: unknown): AnyStep {
    const machine = this.take();
    return next(machine, machine.resume(value, this.budget), this.budget);
  }

  raise(error: unknown): AnyStep {
    const machine = this.take();
    return next(machine, machine.raise(error, this.budget), this.budget);
  }

  cancel(): AnyStep {
    const machine = this.take();
    return next(machine, machine.cancel(this.budget), this.budget);
  }

  continue(): AnyStep {
    const machine = this.take();
    return next(machine, machine.continue(this.budget), this.budget);
  }

  [Symbol.dispose](): void {
    if (this.machine === undefined) return;
    let step = this.cancel();
    while (!step.done) step = step.yielded ? step.continue() : step.cancel();
  }

  private take(): Machine {
    const machine = this.machine;
    if (machine === undefined) throw new Error("step already used");
    this.machine = undefined;
    return machine;
  }
}

class Suspended extends Held {
  readonly yielded = false;
  readonly key: PropertyKey;
  readonly payload: unknown;

  constructor(machine: Machine, budget: number) {
    super(machine, budget);
    this.key = machine.key;
    this.payload = machine.payload;
  }
}

class Halted extends Held {
  readonly yielded = true;
}

const next = (machine: Machine, outcome: Outcome, budget: number): AnyStep =>
  outcome === "done"
    ? { done: true, value: machine.value }
    : outcome === "yielded"
      ? new Halted(machine, budget)
      : new Suspended(machine, budget);

export function step<A, S extends Row>(k: Kyoot<A, S>): Step<A, S>;
export function step<A, S extends Row>(k: Kyoot<A, S>, options: StepOptions): Step<A, S, true>;
export function step<A, S extends Row>(k: Kyoot<A, S>, options?: StepOptions): Step<A, S, true> {
  const n = node(k);
  if (n._tag === "pure") return { done: true, value: n.a as A };
  const budget = options?.budget ?? Infinity;
  const machine = new Machine();
  return next(machine, machine.start(k as AnyKyoot, budget), budget) as Step<A, S, true>;
}

export function runSync<A, S extends Row>(k: Kyoot<A, S> & Only<S>): A {
  const first = step(k as AnyKyoot) as Done<unknown> | Suspended;
  if (first.done) return first.value as A;
  first[Symbol.dispose]();
  throw new Error(`runSync encountered unhandled effect '${String(first.key)}'`);
}
