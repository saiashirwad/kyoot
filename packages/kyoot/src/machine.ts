import { genNode, InterruptedError, isKyoot, KyootImpl } from "./core.ts";
import {
  NodeSym,
  type AnyKyoot,
  type HandlerNode,
  type RuntimeNode,
  type Snapshot,
} from "./model.ts";

type Phase = "node" | "value";
type MachineState = "idle" | "running" | "done" | "suspended" | "yielded";
type OpNode = Extract<RuntimeNode, { _tag: "op" }>;
type FlatMapNode = Extract<RuntimeNode, { _tag: "flatMap" }>;

// How a step ended. `done`: read `value`. `suspended`: an op no frame
// answers; read `key`, `payload`, and `handlers`. `yielded`: out of budget.
export type Outcome = "done" | "suspended" | "yielded";

class GeneratorFrame {
  readonly generator: Generator<AnyKyoot, unknown, unknown>;

  constructor(generator: Generator<AnyKyoot, unknown, unknown>) {
    this.generator = generator;
  }
}

class RethrowFrame {
  readonly error: unknown;

  constructor(error: unknown) {
    this.error = error;
  }
}

// Sits under a handler's `onOp` program while the handler still holds the
// continuation. If the program ends, fails, or is interrupted before it
// resumes, the continuation is dropped and its frames unwind.
class SettleFrame {
  readonly frame: HandlerFrame;

  constructor(frame: HandlerFrame) {
    this.frame = frame;
  }
}

// A handler on the stack, and its continuation once an op reaches it. The
// frames the op crossed, this one first, sit in `captured` while the
// handler's program runs outside them; `resume` records what to continue
// with and hands back `token`, and reaching the token as a node puts the
// frames back. While `onOp` itself runs the frame is armed: a resume then
// returns the token for the machine to continue in place, nothing captured
// and nothing allocated.
class HandlerFrame {
  readonly handler: HandlerNode;
  state: unknown;
  captured: StackEntry[] | undefined;
  dropped = false;
  private armed = false;
  resumed = false;
  resumeKind: "value" | "program" = "value";
  resumeValue: unknown;
  nextState: unknown;
  readonly token: KyootImpl<any, any>;
  readonly resume: ((value: unknown, state?: unknown) => AnyKyoot) & {
    with: (program: AnyKyoot, state?: unknown) => AnyKyoot;
  };

  constructor(handler: HandlerNode) {
    this.handler = handler;
    const hooks = handler.c;
    this.state = hooks.create === undefined ? hooks.initial : hooks.create();
    this.nextState = this.state;
    this.token = new KyootImpl("resume", this);
    this.resume = makeResume(this);
  }

  prepare(): void {
    this.armed = true;
    this.resumed = false;
  }

  disarm(): void {
    this.armed = false;
  }

  claim(kind: "value" | "program", value: unknown, state: unknown): AnyKyoot {
    if (this.resumed) throw new Error("continuation resumed twice (one-shot law)");
    if (!this.armed && this.captured === undefined) {
      throw new Error(
        this.dropped
          ? "continuation resumed after it was dropped"
          : "continuation resumed twice (one-shot law)",
      );
    }
    this.resumed = true;
    this.resumeKind = kind;
    this.resumeValue = value;
    this.nextState = state;
    return this.token;
  }
}

// `resume(v, st)` sets the state to `st` when given, even `undefined`; left
// out, the state stays. Plain functions, so `arguments.length` tells the two
// apart without a rest array per call.
const makeResume = (frame: HandlerFrame): HandlerFrame["resume"] => {
  const resume = function (value: unknown, state?: unknown): AnyKyoot {
    return frame.claim("value", value, arguments.length > 1 ? state : frame.state);
  };
  resume.with = function (program: AnyKyoot, state?: unknown): AnyKyoot {
    return frame.claim("program", program, arguments.length > 1 ? state : frame.state);
  };
  return resume;
};

// A `map` is its bare function; a `flatMap` is the program itself, already
// allocated when it was built. Frames are made as the machine runs.
type StackEntry =
  | ((value: unknown) => unknown)
  | AnyKyoot
  | GeneratorFrame
  | HandlerFrame
  | RethrowFrame
  | SettleFrame;

// The program that unwinds abandoned frames as an interrupt would: each
// handler's `onInterrupt`, innermost first, and the same for continuations
// still held inside. Undefined when there is nothing to run. Entries below
// `from` stay: a frame that dropped its own continuation is not unwound.
const unwinding = (entries: readonly StackEntry[], from = 0): AnyKyoot | undefined => {
  const steps: Array<() => AnyKyoot | undefined> = [];
  for (let i = entries.length - 1; i >= from; i--) {
    const entry = entries[i]!;
    if (entry instanceof SettleFrame) {
      const inner = dropHeld(entry.frame);
      if (inner !== undefined) steps.push(() => inner);
    } else if (entry instanceof HandlerFrame) {
      const { onInterrupt } = entry.handler.c;
      if (onInterrupt === undefined) continue;
      steps.push(() => {
        const fin = onInterrupt(entry.state);
        return isKyoot(fin) ? fin : undefined;
      });
    }
  }
  if (steps.length === 0) return undefined;
  return genNode(function* () {
    for (const step of steps) {
      const k = step();
      if (k !== undefined) yield* k;
    }
  });
};

// Drop the continuation a frame still holds and return its unwinding, or
// undefined if the frame had resumed: its token holds the frames then. The
// frame itself, first in what it holds, stays: it is the one doing the
// dropping.
const dropHeld = (frame: HandlerFrame): AnyKyoot | undefined => {
  const held = frame.captured;
  if (held === undefined || frame.resumed) return undefined;
  frame.captured = undefined;
  frame.dropped = true;
  return unwinding(held, 1);
};

/**
 * An interpreter for one program at a time. It keeps its stack across
 * asynchronous suspension and scheduler yields. Callers start, continue,
 * resume, or raise it, and read the outcome off its fields.
 */
export class Machine {
  private readonly stack: StackEntry[] = [];
  private state: MachineState = "idle";
  private phase: Phase = "node";
  private current!: AnyKyoot;
  private remaining = Infinity;

  // The result, once `done`.
  value: unknown;
  // The op no frame answered, once `suspended`; `handlers` is the frames it
  // crossed, innermost first, when it collects them.
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

  // Ready for another program. The stack keeps its capacity. Setting
  // `length` is a runtime call even when it is already 0, so skip it then.
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
      } else if (top instanceof SettleFrame) {
        // The handler's program finished. If it never resumed, the
        // continuation is dropped: unwind it, then carry the value on.
        const fin = dropHeld(top.frame);
        if (fin !== undefined) {
          const value = this.value;
          this.stack.push(() => value);
          this.current = fin;
          this.phase = "node";
        }
      } else {
        throw (top as RethrowFrame).error;
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

    // An op built with a list collects the frames it crosses, the one that
    // answers it included, so a fiber it spawns can inherit them.
    const inherited = node.c === undefined ? undefined : this.crossed(node.c, Math.max(index, 0));

    if (index < 0) {
      this.key = key;
      this.payload = node.b;
      this.handlers = inherited;
      return "suspended";
    }

    const frame = this.stack[index] as HandlerFrame;
    frame.prepare();
    let output: AnyKyoot;
    try {
      output = frame.handler.c.onOp(node.b, frame.resume, frame.state, inherited);
    } catch (error) {
      // A throw in onOp is a defect of the handler's scope. The frames the
      // op crossed unwind first; the handler's own frame is gone.
      frame.disarm();
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
    frame.disarm();

    if (output === frame.token) {
      frame.state = frame.nextState;
      if (frame.resumeKind === "program") {
        this.current = frame.resumeValue as AnyKyoot;
        this.phase = "node";
      } else {
        this.value = frame.resumeValue;
        this.phase = "value";
      }
      return undefined;
    }

    // The handler's program runs outside its own frame: the frame and what
    // it encloses come off the stack and go back when its token is reached.
    // Until it resumes, a settle frame under the program catches a drop.
    frame.captured = this.stack.splice(index);
    if (!frame.resumed) this.stack.push(new SettleFrame(frame));
    this.current = output;
    this.phase = "node";
    return undefined;
  }

  private restore(frame: HandlerFrame): void {
    const captured = frame.captured;
    if (captured === undefined) throw new Error("continuation resumed twice (one-shot law)");
    frame.captured = undefined;
    frame.state = frame.nextState;
    for (const entry of captured) this.stack.push(entry);
    if (frame.resumeKind === "program") {
      this.current = frame.resumeValue as AnyKyoot;
      this.phase = "node";
    } else {
      this.value = frame.resumeValue;
      this.phase = "value";
    }
  }

  // An error on its way out. An interrupt runs every frame's `onInterrupt`;
  // a defect stops at the first frame with `onDefect`. A dropped continuation
  // on the way unwinds first, either way.
  private unwind(error: unknown): void {
    const interrupted = error instanceof InterruptedError;
    while (this.stack.length > 0) {
      const entry = this.stack.pop();
      if (entry instanceof SettleFrame) {
        const fin = dropHeld(entry.frame);
        if (fin === undefined) continue;
        this.stack.push(new RethrowFrame(error));
        this.current = fin;
        this.phase = "node";
        return;
      }
      if (!(entry instanceof HandlerFrame)) continue;

      if (interrupted) {
        const cleanup = entry.handler.c.onInterrupt?.(entry.state);
        if (isKyoot(cleanup)) {
          this.stack.push(new RethrowFrame(error));
          this.current = cleanup;
          this.phase = "node";
          return;
        }
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

  // The frames an op that collects them crossed: the seed it carries, then
  // every frame from the top of the stack down to `to`, innermost first.
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
