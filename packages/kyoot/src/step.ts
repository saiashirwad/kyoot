import { node } from "./core.ts";
import { Machine, type Outcome } from "./machine.ts";
import type { AnyKyoot, Kyoot } from "./model.ts";
import type { Answer, Only, Payload, Row } from "./types.ts";

export interface Done<A> {
  readonly done: true;
  readonly value: A;
}

interface PendingAt<A, S extends Row, K extends keyof S> extends Disposable {
  readonly done: false;
  readonly key: K;
  readonly payload: Payload<S, K>;
  resume(value: Answer<S, K>): Step<A, S>;
  raise(error: unknown): Step<A, S>;
  cancel(): Step<undefined, S>;
}

export type Pending<A, S extends Row> = { [K in keyof S]: PendingAt<A, S, K> }[keyof S];

export type Step<A, S extends Row = {}> = Done<A> | Pending<A, S>;

type AnyStep = Done<unknown> | Suspended;

class Suspended implements Disposable {
  readonly done = false;
  readonly key: PropertyKey;
  readonly payload: unknown;
  private machine: Machine | undefined;

  constructor(machine: Machine) {
    this.machine = machine;
    this.key = machine.key;
    this.payload = machine.payload;
  }

  resume(value: unknown): AnyStep {
    const machine = this.take();
    return next(machine, machine.resume(value));
  }

  raise(error: unknown): AnyStep {
    const machine = this.take();
    return next(machine, machine.raise(error));
  }

  cancel(): AnyStep {
    const machine = this.take();
    return next(machine, machine.cancel());
  }

  [Symbol.dispose](): void {
    if (this.machine === undefined) return;
    let step = this.cancel();
    while (!step.done) step = step.cancel();
  }

  private take(): Machine {
    const machine = this.machine;
    if (machine === undefined) throw new Error("step already used");
    this.machine = undefined;
    return machine;
  }
}

const next = (machine: Machine, outcome: Outcome): AnyStep =>
  outcome === "done" ? { done: true, value: machine.value } : new Suspended(machine);

export function step<A, S extends Row>(k: Kyoot<A, S>): Step<A, S> {
  const n = node(k);
  if (n._tag === "pure") return { done: true, value: n.a as A };
  const machine = new Machine();
  return next(machine, machine.start(k as AnyKyoot)) as Step<A, S>;
}

export function runSync<A, S extends Row>(k: Kyoot<A, S> & Only<S>): A {
  const first = step(k as AnyKyoot) as AnyStep;
  if (first.done) return first.value as A;
  first[Symbol.dispose]();
  throw new Error(`runSync encountered unhandled effect '${String(first.key)}'`);
}
