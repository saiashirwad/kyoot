import { genNode, InterruptedError, isKyoot, KyootImpl } from "./core.ts";
import {
  NodeSym,
  type AnyKyoot,
  type HandlerNode,
  type RuntimeNode,
  type RuntimeResume,
  type Snapshot,
} from "./model.ts";

type Phase = "node" | "value";
type MachineState = "idle" | "running" | "done" | "suspended" | "yielded";
type OpNode = Extract<RuntimeNode, { _tag: "op" }>;
type FlatMapNode = Extract<RuntimeNode, { _tag: "flatMap" }>;

export type Outcome = "done" | "suspended" | "yielded";

const FINALLY_YIELDED =
  "a generator finally yielded an effect while the machine was closing it; use Resource for cleanup that performs effects";

class GeneratorFrame {
  readonly generator: Generator<AnyKyoot, unknown, unknown>;

  constructor(generator: Generator<AnyKyoot, unknown, unknown>) {
    this.generator = generator;
  }

  // Closes an abandoned frame the way the language does, so its `finally` blocks run.
  // A `finally` that yields cannot be honoured: the handlers that gave its effects
  // meaning are already off the stack. The frame stays parked at that yield and the
  // drop is reported as a defect rather than half-run.
  close(): void {
    if (!this.generator.return(undefined).done) throw new Error(FINALLY_YIELDED);
  }
}

class SettleFrame {
  readonly frame: HandlerFrame;

  constructor(frame: HandlerFrame) {
    this.frame = frame;
  }
}

type Status = "idle" | "armed" | "held" | "resumed" | "dropped";

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
  token: KyootImpl<any, any> | undefined;
  resume: RuntimeResume | undefined;

  constructor(handler: HandlerNode) {
    this.handler = handler;
    const hooks = handler.c;
    this.state = hooks.create === undefined ? hooks.initial : hooks.create();
  }

  claim(kind: "value" | "program", value: unknown, state: unknown): AnyKyoot {
    if (this.status !== "armed" && this.status !== "held") {
      throw new Error(this.status === "dropped" ? DROPPED : ONE_SHOT);
    }
    this.status = "resumed";
    this.resumeKind = kind;
    this.resumeValue = value;
    this.nextState = state;
    return (this.token ??= new KyootImpl("resume", this));
  }
}

const makeResume = (frame: HandlerFrame): RuntimeResume => {
  const resume = function (value: unknown, state?: unknown): AnyKyoot {
    return frame.claim("value", value, arguments.length > 1 ? state : frame.state);
  };
  resume.with = function (program: AnyKyoot, state?: unknown): AnyKyoot {
    return frame.claim("program", program, arguments.length > 1 ? state : frame.state);
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

// Called rather than thrown inline where the throw sits in a `finally`.
const raise = (thrown: { error: unknown }): never => {
  throw thrown.error;
};

// A frame stands for closing it; a thunk for cleanup that may return a program.
type UnwindStep = GeneratorFrame | (() => AnyKyoot | undefined);

const unwinding = (entries: readonly StackEntry[], from = 0): AnyKyoot | undefined => {
  let steps: UnwindStep[] | undefined;
  let raised: { error: unknown } | undefined;
  let deferred = false;
  // Last wins: the frames close innermost first, and an outer `finally` that throws
  // replaces the error an inner one raised, as nesting them in one generator would.
  const closing = (frame: GeneratorFrame) => {
    try {
      frame.close();
    } catch (error) {
      raised = { error };
    }
  };
  for (let i = entries.length - 1; i >= from; i--) {
    const entry = entries[i]!;
    if (entry instanceof GeneratorFrame) {
      // Innermost first. Closing runs synchronously, so a frame only needs a step of
      // its own once cleanup programs are queued ahead of it.
      if (steps === undefined) closing(entry);
      else {
        deferred = true;
        steps.push(entry);
      }
    } else if (entry instanceof SettleFrame) {
      const inner = dropHeld(entry.frame);
      if (inner !== undefined) (steps ??= []).push(() => inner);
    } else if (entry instanceof HandlerFrame) {
      const { onInterrupt } = entry.handler.c;
      if (onInterrupt === undefined) continue;
      (steps ??= []).push(() => {
        const fin = onInterrupt(entry.state);
        return isKyoot(fin) ? fin : undefined;
      });
    }
  }
  // A throwing `finally` never costs the rest of the walk its cleanup: it surfaces
  // as a defect once every other step has run.
  if (raised !== undefined || deferred) {
    (steps ??= []).push(() => {
      if (raised !== undefined) throw raised.error;
      return undefined;
    });
  }
  if (steps === undefined) return undefined;
  const run = steps;
  return genNode(function* () {
    let i = 0;
    try {
      for (; i < run.length; i++) {
        const step = run[i]!;
        if (step instanceof GeneratorFrame) {
          closing(step);
          continue;
        }
        const k = step();
        if (k !== undefined) yield* k;
      }
    } finally {
      // This program is itself a generator frame, so if it is abandoned part-way —
      // the machine stopped, an outer handler dropped it, a cleanup step failed —
      // closing it lands here and the frames it never reached still close. Cleanup
      // that performs effects is not run: there is no machine left to run it on.
      let missed: { error: unknown } | undefined;
      for (; i < run.length; i++) {
        const step = run[i]!;
        if (!(step instanceof GeneratorFrame)) continue;
        try {
          step.close();
        } catch (error) {
          missed = { error };
        }
      }
      if (missed !== undefined) raise(missed);
    }
  });
};

// Closes every generator frame a machine leaves behind when it stops with a stack:
// the frames on it, and the ones parked inside a continuation a handler is still
// holding or has claimed and never restored. Cleanup that performs effects is not
// run — there is no machine left to run it on. Each frame lives in exactly one of
// these arrays, and a holder sits at its own `captured[0]`, so skipping that slot
// visits every frame once. The last `finally` to throw — the outermost — is reported
// once they are all closed.
const closeAll = (entries: readonly StackEntry[]): void => {
  let raised: { error: unknown } | undefined;
  // A handler that has held more than once leaves earlier settle frames on the
  // stack, so the same continuation can be reached twice; walk each array once.
  let seen: Set<readonly StackEntry[]> | undefined;
  const walk = (frames: readonly StackEntry[], from: number): void => {
    for (let i = frames.length - 1; i >= from; i--) {
      const entry = frames[i]!;
      if (entry instanceof GeneratorFrame) {
        try {
          entry.close();
        } catch (error) {
          raised = { error };
        }
        continue;
      }
      const captured =
        entry instanceof SettleFrame
          ? entry.frame.captured
          : entry instanceof HandlerFrame
            ? entry.captured
            : undefined;
      if (captured === undefined) continue;
      seen ??= new Set();
      if (seen.has(captured)) continue;
      seen.add(captured);
      walk(captured, 1);
    }
  };
  walk(entries, 0);
  if (raised !== undefined) throw raised.error;
};

// Reaching a settle frame whose continuation is still captured means nobody restored
// it: the handler never resumed, or it claimed a token and threw the token away. Either
// way the continuation is dead and unwinds here. A restored one has cleared `captured`,
// so its settle frame is inert.
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
    // Everything above is cleared first: the machine is reusable even if a
    // `finally` throws on the way out.
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
            this.restore(node.a as HandlerFrame);
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
          const value = this.value;
          this.stack.push(() => value);
          this.current = fin;
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
      const resume = (frame.resume ??= makeResume(frame));
      output = frame.handler.c.onOp(node.b, resume, frame.state, inherited);
    } catch (error) {
      frame.status = "idle";
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

    if (output === frame.token) {
      this.continueFrom(frame);
      return undefined;
    }

    frame.captured = this.stack.splice(index);
    if ((frame.status as Status) !== "resumed") frame.status = "held";
    // A settle frame marks where the continuation was taken from, for a held frame
    // so a drop can unwind it, and for one already claimed so a machine that stops
    // before the resume lands can still close the generators parked in it. It is
    // inert once the frame is no longer held.
    this.stack.push(new SettleFrame(frame));
    this.current = output;
    this.phase = "node";
    return undefined;
  }

  private restore(frame: HandlerFrame): void {
    const captured = frame.captured;
    if (captured === undefined) throw new Error(frame.status === "dropped" ? DROPPED : ONE_SHOT);
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
        // A `finally` that throws replaces the error in flight, as it does in
        // JavaScript; the stack below it still unwinds.
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
        const cleanup = entry.handler.c.onInterrupt?.(entry.state);
        if (isKyoot(cleanup)) return this.cleanupThen(cleanup, error);
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
