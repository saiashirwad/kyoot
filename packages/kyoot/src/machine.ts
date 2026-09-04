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

class GeneratorFrame {
  readonly generator: Generator<AnyKyoot, unknown, unknown>;

  constructor(generator: Generator<AnyKyoot, unknown, unknown>) {
    this.generator = generator;
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

const unwinding = (entries: readonly StackEntry[], from = 0): AnyKyoot | undefined => {
  let steps: Array<() => AnyKyoot | undefined> | undefined;
  for (let i = entries.length - 1; i >= from; i--) {
    const entry = entries[i]!;
    if (entry instanceof SettleFrame) {
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
  if (steps === undefined) return undefined;
  const run = steps;
  return genNode(function* () {
    for (const step of run) {
      const k = step();
      if (k !== undefined) yield* k;
    }
  });
};

// A SettleFrame guards a captured continuation until something claims it back. Reaching one
// with `captured` still set means nobody ever restored it -- whether the handler never resumed
// ("held") or claimed a token and then threw it away ("resumed") -- so its finalizers run here.
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

  // Called when a run stops mid-program (an unhandled effect, a fiber torn down): the stack still
  // holds handler frames and captured continuations whose finalizers nobody else will run.
  // `unserved` builds the error for an effect a finalizer performs that nothing here can answer;
  // it fails at that op rather than interrupting again, which would abandon the rest of the scope
  // being released. Whatever a finalizer throws is swallowed: the caller already knows why the run
  // stopped, and that reason stays authoritative.
  discard(unserved: (key: PropertyKey) => unknown): void {
    let error: unknown = new InterruptedError();
    while (this.stack.length > 0) {
      let outcome: Outcome;
      try {
        outcome = this.advance(Infinity, true, error);
      } catch {
        return;
      }
      if (outcome !== "suspended") return;
      error = unserved(this.key);
    }
  }

  reset(): void {
    if (this.stack.length !== 0) this.stack.length = 0;
    this.state = "idle";
    this.phase = "node";
    this.current = undefined!;
    this.value = undefined;
    this.payload = undefined;
    this.handlers = undefined;
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
    this.stack.push(new SettleFrame(frame));
    this.current = output;
    this.phase = "node";
    return undefined;
  }

  private restore(frame: HandlerFrame): void {
    const captured = frame.captured;
    if (captured === undefined) {
      throw new Error(frame.status === "dropped" ? DROPPED : ONE_SHOT);
    }
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
