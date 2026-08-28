import { genNode, InterruptedError, isKyoot, KyootImpl } from "./core.ts";
import { NodeSym, type AnyKyoot, type HandlerNode, type RuntimeNode } from "./model.ts";

type Phase = "node" | "value";
type MachineState = "idle" | "running" | "done" | "suspended" | "yielded";
type Failure = { readonly error: unknown };
type OpNode = Extract<RuntimeNode, { _tag: "op" }>;
type FlatMapNode = Extract<RuntimeNode, { _tag: "flatMap" }>;

// How a step ended. `done`: read `value`. `suspended`: an op no frame
// answers; read `key`, `payload`, and `handlers`. `yielded`: out of budget.
export type Outcome = "done" | "suspended" | "yielded";

// A continuation resumed after its handler's `onOp` returned: the frames to
// put back, the handler's next state, and what the program continues with.
type ResumeState = {
  readonly captured: StackEntry[];
  readonly frame: HandlerFrame;
  readonly state: unknown;
  readonly kind: "value" | "program";
  readonly value: unknown;
};

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

class HandlerFrame {
  readonly handler: HandlerNode;
  state: unknown;
  // The frames the op crossed, this one first, held until `resume` takes
  // them or a drop unwinds them.
  captured: StackEntry[] | undefined;
  dropped = false;

  // Armed while `onOp` runs: a resume then returns the token and the machine
  // continues in place, with nothing captured and nothing allocated.
  private armed = false;
  private resumed = false;
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
    const entered = hooks.entered ?? hooks.create === undefined;
    this.state = entered
      ? hooks.entered === true
        ? hooks.state
        : hooks.initial
      : hooks.create === undefined
        ? hooks.initial
        : hooks.create();
    this.nextState = this.state;
    this.token = new KyootImpl("resume", this);

    this.resume = makeResume(this);
  }

  prepare(): void {
    this.armed = true;
    this.resumed = false;
    if (this.token.a !== this) this.token.a = this;
  }

  disarm(): void {
    this.armed = false;
  }

  didResume(): boolean {
    return this.resumed;
  }

  takeResume(captured: StackEntry[]): ResumeState {
    return {
      captured,
      frame: this,
      state: this.nextState,
      kind: this.resumeKind,
      value: this.resumeValue,
    };
  }

  claim(kind: "value" | "program", value: unknown, state: unknown): AnyKyoot {
    if (this.armed) {
      if (this.resumed) throw new Error("continuation resumed twice (one-shot law)");
      this.resumed = true;
      this.resumeKind = kind;
      this.resumeValue = value;
      this.nextState = state;
      return this.token;
    }

    const captured = this.captured;
    if (captured === undefined) {
      throw new Error(
        this.dropped
          ? "continuation resumed after it was dropped"
          : "continuation resumed twice (one-shot law)",
      );
    }
    this.captured = undefined;
    return new KyootImpl("resume", {
      captured,
      frame: this,
      state,
      kind,
      value,
    } satisfies ResumeState);
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
// undefined if the frame had resumed. The frame itself, first in what it
// holds, stays: it is the one doing the dropping.
const dropHeld = (frame: HandlerFrame): AnyKyoot | undefined => {
  const held = frame.captured;
  if (held === undefined) return undefined;
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
  handlers: readonly HandlerNode[] | undefined;

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
    return this.advance(budget, { error });
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

  private advance(budget: number, initialFailure?: Failure): Outcome {
    this.state = "running";
    this.remaining = budget;
    let failure = initialFailure;

    while (true) {
      if (failure !== undefined) {
        try {
          this.unwind(failure.error);
          failure = undefined;
        } catch (next) {
          failure = { error: next };
          if (this.stack.length === 0) throw next;
        }
      }

      try {
        return (this.state = this.drive());
      } catch (next) {
        failure = { error: next };
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
            this.restore(node.a);
            break;
          case "raise":
            throw node.a;
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
    const inherited =
      node.c === undefined ? undefined : this.crossed(node.c, Math.max(index, 0));

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
    // it encloses come off the stack and go back when the program resumes.
    const captured = this.stack.splice(index);
    if (frame.didResume()) {
      frame.token.a = frame.takeResume(captured);
    } else {
      frame.captured = captured;
      this.stack.push(new SettleFrame(frame));
    }
    this.current = output;
    this.phase = "node";
    return undefined;
  }

  private restore(state: unknown): void {
    if (state instanceof HandlerFrame) {
      throw new Error("continuation resumed twice (one-shot law)");
    }
    const resume = state as ResumeState;
    resume.frame.state = resume.state;
    for (const entry of resume.captured) this.stack.push(entry);
    if (resume.kind === "program") {
      this.current = resume.value as AnyKyoot;
      this.phase = "node";
    } else {
      this.value = resume.value;
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
  private crossed(seed: readonly HandlerNode[], to: number): readonly HandlerNode[] {
    let handlers: HandlerNode[] | undefined;
    for (let index = this.stack.length - 1; index >= to; index--) {
      const entry = this.stack[index];
      if (!(entry instanceof HandlerFrame) || entry.handler.c.fork === "none") continue;
      const snapshot = new KyootImpl("handler", entry.handler.a, entry.handler.b, {
        ...entry.handler.c,
        state: entry.state,
        entered: true,
      })[NodeSym];
      if (handlers === undefined) handlers = seed.slice();
      handlers.push(snapshot as HandlerNode);
    }
    return handlers ?? seed;
  }
  private spend(): boolean {
    if (this.remaining <= 0) return false;
    this.remaining--;
    return true;
  }
}
