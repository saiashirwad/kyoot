import { InterruptedError, isKyoot, KyootImpl } from "./core.ts";
import {
  NodeSym,
  type AnyKyoot,
  type HandlerNode,
  type RuntimeNode,
  type RuntimeResume,
  type Snapshot,
} from "./model.ts";
import { CleanupError, Result, cleanupFailuresFrom } from "./result.ts";

type Phase = "node" | "value";
type MachineState = "idle" | "running" | "done" | "suspended" | "yielded";
type OpNode = Extract<RuntimeNode, { _tag: "op" }>;
type FlatMapNode = Extract<RuntimeNode, { _tag: "flatMap" }>;

export type Outcome = "done" | "suspended" | "yielded";

const FINALLY_YIELDED =
  "a generator finally yielded an effect while the machine was closing it; use Resource for cleanup that performs effects";

class GeneratorFrame {
  readonly generator: Generator<AnyKyoot, unknown, unknown>;
  private closed = false;

  constructor(generator: Generator<AnyKyoot, unknown, unknown>) {
    this.generator = generator;
  }

  // Runs the frame's `finally` blocks. One that yields cannot be honoured — the
  // handlers that gave its effects meaning are already off the stack — so the frame
  // stays parked there and the drop is reported as a defect.
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.generator.return(undefined).done) throw new Error(FINALLY_YIELDED);
  }
}

class SettleFrame {
  readonly frame: HandlerFrame;

  constructor(frame: HandlerFrame) {
    this.frame = frame;
  }
}

type Status = "idle" | "armed" | "held" | "claimed" | "running" | "dropped";

const ONE_SHOT = "continuation resumed twice (one-shot law)";
const DROPPED = "continuation resumed after it was dropped";

class HandlerFrame {
  readonly handler: HandlerNode;
  state: unknown;
  status: Status = "idle";
  captured: StackEntry[] | undefined;
  resumeKind: "value" | "program" = "value";
  resumeValue: unknown;
  nextState: unknown;
  epoch = 0;

  constructor(handler: HandlerNode) {
    this.handler = handler;
    const hooks = handler.c;
    this.state = hooks.create === undefined ? hooks.initial : hooks.create();
  }

  claim(epoch: number, kind: "value" | "program", value: unknown, state: unknown): AnyKyoot {
    if (this.status !== "armed" && this.status !== "held") {
      throw new Error(this.status === "dropped" ? DROPPED : ONE_SHOT);
    }
    if (epoch !== this.epoch) throw new Error(ONE_SHOT);
    this.status = "claimed";
    this.resumeKind = kind;
    this.resumeValue = value;
    this.nextState = state;
    return new KyootImpl("resume", this, epoch);
  }

  execute(epoch: number): void {
    if (epoch !== this.epoch || this.status !== "claimed") {
      throw new Error(this.status === "dropped" ? DROPPED : ONE_SHOT);
    }
    this.status = "running";
  }
}

const makeResume = (frame: HandlerFrame, epoch: number): RuntimeResume => {
  const resume = function (value: unknown, state?: unknown): AnyKyoot {
    return frame.claim(epoch, "value", value, arguments.length > 1 ? state : frame.state);
  };
  resume.with = function (program: AnyKyoot, state?: unknown): AnyKyoot {
    return frame.claim(epoch, "program", program, arguments.length > 1 ? state : frame.state);
  };
  return resume;
};

type StackEntry =
  | ((value: unknown) => unknown)
  | AnyKyoot
  | GeneratorFrame
  | HandlerFrame
  | SettleFrame;

const rethrow = (error: unknown) => () => {
  throw error;
};

// A frame stands for closing it, a settle frame for dropping the continuation it holds,
// a thunk for cleanup that may return a program.
type UnwindStep = GeneratorFrame | SettleFrame | (() => AnyKyoot | undefined);

// Closes generator frames nothing will run again: those it is given, and those parked in
// a continuation nobody restored. Closing a continuation marks it dropped, so a saved
// token cannot restore frames that are already closed. Cleanup that performs effects is
// skipped — there is no machine left to run it. An outer `finally` that throws replaces
// an inner one's error, as nesting them in one generator would.
const closer = (saved: { error: unknown } | undefined) => {
  let thrown = saved;
  const drop = (frame: HandlerFrame): void => {
    const captured = frame.captured;
    if (captured === undefined) return;
    frame.captured = undefined;
    frame.status = "dropped";
    for (let i = captured.length - 1; i >= 1; i--) close(captured[i]!);
  };
  const close = (entry: StackEntry | UnwindStep): void => {
    if (entry instanceof GeneratorFrame) {
      try {
        entry.close();
      } catch (error) {
        thrown = { error };
      }
    } else if (entry instanceof SettleFrame) drop(entry.frame);
    else if (entry instanceof HandlerFrame) drop(entry);
  };
  return {
    close,
    finish: (): void => {
      if (thrown !== undefined) throw thrown.error;
    },
  };
};

const unwindAttempt = Symbol("kyoot/unwind-attempt");
const restoreAfterCleanup = Symbol("kyoot/restore-after-cleanup");
const unit = new KyootImpl("pure", undefined);

const raise = (error: unknown): AnyKyoot =>
  unit.map(() => {
    throw error;
  });

const afterCleanup = (cleanup: AnyKyoot, value: unknown): AnyKyoot =>
  new KyootImpl("handler", cleanup, restoreAfterCleanup, {
    recoverInterrupt: true,
    onOp: () => {
      throw new Error("unreachable cleanup restore handler");
    },
    onSuccess: () => new KyootImpl("pure", value),
    onDefect: (error: unknown) => {
      if (error instanceof CleanupError) {
        const amended = Result.addCleanupTo(value, cleanupFailuresFrom(error));
        if (amended !== undefined) return new KyootImpl("pure", amended);
      }
      return raise(error);
    },
    onInterrupt: (_state: unknown, cause?: unknown) => {
      if (cause === undefined) return unit;
      const amended = Result.addCleanupTo(value, [{ _tag: "Interrupted" }]);
      return amended === undefined ? raise(new InterruptedError()) : new KyootImpl("pure", amended);
    },
  });

interface UnwindWalk {
  readonly steps: readonly (() => AnyKyoot | undefined)[];
  index: number;
  raised: { error: unknown } | undefined;
}

const walk = (state: UnwindWalk): AnyKyoot => {
  const step = state.steps[state.index++];
  if (step === undefined) {
    if (state.raised !== undefined) {
      const error = state.raised.error;
      return raise(error);
    }
    return unit;
  }

  const deferred = unit.flatMap(() => step() ?? unit);
  return new KyootImpl("handler", deferred, unwindAttempt, {
    interruptMask: true,
    recoverInterrupt: true,
    onOp: () => {
      throw new Error("unreachable unwind handler");
    },
    onSuccess: () => walk(state),
    onDefect: (error: unknown) => {
      state.raised = { error };
      return walk(state);
    },
    onInterrupt: (_handlerState: unknown, cause?: unknown) => {
      if (cause !== undefined) state.raised = { error: cause };
      return walk(state);
    },
  });
};

const unwinding = (entries: readonly StackEntry[], from = 0): AnyKyoot | undefined => {
  const steps: Array<() => AnyKyoot | undefined> = [];
  for (let i = entries.length - 1; i >= from; i--) {
    const entry = entries[i]!;
    if (entry instanceof GeneratorFrame) {
      steps.push(() => {
        entry.close();
        return undefined;
      });
    } else if (entry instanceof SettleFrame) {
      if (entry.frame.captured !== undefined) steps.push(() => dropHeld(entry.frame));
    } else if (entry instanceof HandlerFrame) {
      const { onInterrupt } = entry.handler.c;
      if (onInterrupt === undefined) continue;
      steps.push(() => {
        const cleanup = onInterrupt(entry.state);
        return isKyoot(cleanup) ? cleanup : undefined;
      });
    }
  }
  return steps.length === 0 ? undefined : walk({ steps, index: 0, raised: undefined });
};

const closeAll = (entries: readonly StackEntry[]): void => {
  const { close, finish } = closer(undefined);
  for (let i = entries.length - 1; i >= 0; i--) close(entries[i]!);
  finish();
};

// Reaching a settle frame whose continuation is still captured means nobody restored it: the
// handler never resumed, or it claimed a token and threw the token away. A restored continuation
// has cleared `captured`, so its settle frame is inert.
const dropHeld = (frame: HandlerFrame): AnyKyoot | undefined => {
  const held = frame.captured;
  if (held === undefined) return undefined;
  frame.captured = undefined;
  frame.status = "dropped";
  return unwinding(held, 1);
};

export class Machine {
  private readonly stack: StackEntry[] = [];
  private state: MachineState = "idle";
  private phase: Phase = "node";
  private current!: AnyKyoot;
  private remaining = Infinity;

  value: unknown;
  key: PropertyKey = "";
  payload: unknown;
  handlers: readonly Snapshot[] | undefined;

  get interruptMasked(): boolean {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const entry = this.stack[i];
      if (entry instanceof HandlerFrame && entry.handler.c.interruptMask === true) return true;
    }
    return false;
  }

  start(program: AnyKyoot, budget = Infinity): Outcome {
    if (this.state !== "idle") throw new Error("machine already started");
    this.current = program;
    this.phase = "node";
    return this.advance(budget);
  }

  continue(budget = Infinity): Outcome {
    if (this.state !== "yielded") throw new Error("machine is not yielded");
    return this.advance(budget);
  }

  resume(value: unknown, budget = Infinity): Outcome {
    if (this.state !== "suspended") throw new Error("machine is not suspended");
    this.value = value;
    this.phase = "value";
    return this.advance(budget);
  }

  raise(error: unknown, budget = Infinity): Outcome {
    if (this.state !== "suspended" && this.state !== "yielded") {
      throw new Error("machine cannot be raised here");
    }
    return this.advance(budget, true, error);
  }

  reset(): void {
    const abandoned = this.stack.length === 0 ? undefined : this.stack.slice();
    if (abandoned !== undefined) this.stack.length = 0;
    this.state = "idle";
    this.phase = "node";
    this.current = undefined!;
    this.value = undefined;
    this.payload = undefined;
    this.handlers = undefined;
    // Cleared first, so the machine is reusable even if a `finally` throws on the way out.
    if (abandoned !== undefined) closeAll(abandoned);
  }

  private advance(budget: number, failed = false, error?: unknown): Outcome {
    this.state = "running";
    this.remaining = budget;

    while (true) {
      if (failed) {
        try {
          this.unwind(error);
          failed = false;
        } catch (next) {
          error = next;
          if (this.stack.length === 0) throw next;
        }
      }

      try {
        return (this.state = this.drive());
      } catch (next) {
        failed = true;
        error = next;
      }
    }
  }

  private drive(): Outcome {
    while (true) {
      if (!this.spend()) return "yielded";

      if (this.phase === "node") {
        const node = this.current[NodeSym];
        switch (node._tag) {
          case "pure":
            this.value = node.a;
            this.phase = "value";
            break;
          case "map":
            this.stack.push(node.b);
            this.current = node.a;
            break;
          case "flatMap":
            this.stack.push(this.current);
            this.current = node.a;
            break;
          case "gen":
            this.stack.push(new GeneratorFrame(node.a()));
            this.value = undefined;
            this.phase = "value";
            break;
          case "op": {
            const handled = this.handle(node);
            if (handled !== undefined) return handled;
            break;
          }
          case "handler":
            this.stack.push(new HandlerFrame(node));
            this.current = node.a;
            break;
          case "resume":
            this.restore(node.a as HandlerFrame, node.b);
            break;
        }
        continue;
      }

      const top = this.stack.pop();
      if (top === undefined) return "done";

      if (typeof top === "function") {
        this.value = top(this.value);
      } else if (top instanceof KyootImpl) {
        this.current = (top[NodeSym] as FlatMapNode).b(this.value);
        this.phase = "node";
      } else if (top instanceof GeneratorFrame) {
        let step = top.generator.next(this.value);
        while (!step.done) {
          const yielded = step.value[NodeSym];
          if (yielded._tag !== "pure") {
            this.stack.push(top);
            this.current = step.value;
            this.phase = "node";
            break;
          }
          if (!this.spend()) {
            this.stack.push(top);
            this.current = step.value;
            this.phase = "node";
            return "yielded";
          }
          this.value = yielded.a;
          step = top.generator.next(this.value);
        }
        if (step.done) this.value = step.value;
      } else if (top instanceof HandlerFrame) {
        const onSuccess = top.handler.c.onSuccess;
        if (onSuccess !== undefined) {
          this.current = onSuccess(this.value, top.state);
          this.phase = "node";
        }
      } else {
        const fin = dropHeld((top as SettleFrame).frame);
        if (fin !== undefined) {
          this.current = afterCleanup(fin, this.value);
          this.phase = "node";
        }
      }
    }
  }

  private handle(node: OpNode): Outcome | undefined {
    const key = node.a;
    let index = this.stack.length - 1;
    for (; index >= 0; index--) {
      const entry = this.stack[index];
      if (entry instanceof HandlerFrame && entry.handler.b === key) break;
    }

    const inherited = node.c === undefined ? undefined : this.crossed(node.c, Math.max(index, 0));

    if (index < 0) {
      this.key = key;
      this.payload = node.b;
      this.handlers = inherited;
      return "suspended";
    }

    const frame = this.stack[index] as HandlerFrame;
    frame.status = "armed";
    let output: AnyKyoot;
    try {
      const resume = makeResume(frame, ++frame.epoch);
      output = frame.handler.c.onOp(node.b, resume, frame.state, inherited);
    } catch (error) {
      frame.status = (frame.status as Status) === "claimed" ? "dropped" : "idle";
      const crossed = this.stack.splice(index + 1);
      this.stack.length = index;
      const fin = unwinding(crossed);
      const onDefect = frame.handler.c.onDefect;
      const next = (): AnyKyoot => {
        if (onDefect === undefined) throw error;
        return onDefect(error, frame.state);
      };
      this.current = fin === undefined ? next() : fin.flatMap(next);
      this.phase = "node";
      return undefined;
    }

    const returned = output[NodeSym];
    if (returned._tag === "resume" && returned.a === frame && returned.b === frame.epoch) {
      frame.execute(frame.epoch);
      this.continueFrom(frame);
      return undefined;
    }

    frame.captured = this.stack.splice(index);
    if ((frame.status as Status) !== "claimed") frame.status = "held";
    this.stack.push(new SettleFrame(frame));
    this.current = output;
    this.phase = "node";
    return undefined;
  }

  private restore(frame: HandlerFrame, epoch: number): void {
    const captured = frame.captured;
    if (captured === undefined) throw new Error(frame.status === "dropped" ? DROPPED : ONE_SHOT);
    frame.execute(epoch);
    frame.captured = undefined;
    for (let i = 0; i < captured.length; i++) this.stack.push(captured[i]!);
    this.continueFrom(frame);
  }

  private continueFrom(frame: HandlerFrame): void {
    frame.state = frame.nextState;
    if (frame.resumeKind === "program") {
      this.current = frame.resumeValue as AnyKyoot;
      this.phase = "node";
    } else {
      this.value = frame.resumeValue;
      this.phase = "value";
    }
  }

  private cleanupThen(cleanup: AnyKyoot, error: unknown): void {
    this.stack.push(rethrow(error));
    this.current = cleanup;
    this.phase = "node";
  }

  private unwind(error: unknown): void {
    const interrupted = error instanceof InterruptedError;
    while (this.stack.length > 0) {
      const entry = this.stack.pop();
      if (entry instanceof GeneratorFrame) {
        entry.close();
        continue;
      }
      if (entry instanceof SettleFrame) {
        const fin = dropHeld(entry.frame);
        if (fin !== undefined) return this.cleanupThen(fin, error);
        continue;
      }
      if (!(entry instanceof HandlerFrame)) continue;

      if (interrupted) {
        const hooks = entry.handler.c;
        const cleanup = hooks.onInterrupt?.(entry.state, error);
        if (isKyoot(cleanup)) {
          if (hooks.recoverInterrupt === true) {
            this.current = cleanup;
            this.phase = "node";
          } else {
            this.cleanupThen(cleanup, error);
          }
          return;
        }
        if (hooks.recoverInterrupt === true) continue;
        continue;
      }

      const onDefect = entry.handler.c.onDefect;
      if (onDefect !== undefined) {
        this.current = onDefect(error, entry.state);
        this.phase = "node";
        return;
      }
    }
    throw error;
  }

  private crossed(seed: readonly Snapshot[], to: number): readonly Snapshot[] {
    let snapshots: Snapshot[] | undefined;
    for (let index = this.stack.length - 1; index >= to; index--) {
      const entry = this.stack[index];
      if (!(entry instanceof HandlerFrame) || entry.handler.c.fork === "none") continue;
      if (snapshots === undefined) snapshots = seed.slice();
      snapshots.push({ node: entry.handler, state: entry.state });
    }
    return snapshots ?? seed;
  }

  private spend(): boolean {
    if (this.remaining <= 0) return false;
    this.remaining--;
    return true;
  }
}
