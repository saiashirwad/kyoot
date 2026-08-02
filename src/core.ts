import {
  NodeSym,
  type AnyKyoot,
  type Continuation,
  type GenCache,
  type Kyoot,
  type RuntimeNode,
} from "./model.ts";
import { pipeArguments } from "./pipe.ts";
import type { Row } from "./types.ts";

export type { AnyKyoot, Kyoot, OnOp } from "./model.ts";

export class KyootImpl<A, S extends Row = {}> implements Kyoot<A, S> {
  readonly [NodeSym]: RuntimeNode;

  constructor(node: RuntimeNode) {
    this[NodeSym] = node;
  }

  map(mapper: (a: any) => any): AnyKyoot {
    return new KyootImpl({ _tag: "map", self: this as AnyKyoot, mapper });
  }

  pipe(...fns: Array<(x: any) => any>) {
    return pipeArguments(this, fns);
  }

  [Symbol.iterator]() {
    let used = false;
    const self = this;
    return {
      next(v: unknown): IteratorResult<Kyoot<unknown, S>, A> {
        if (used) return { done: true, value: v as A };
        used = true;
        return { done: false, value: self };
      },
    };
  }
}

export const isKyoot = (value: unknown): value is AnyKyoot => value instanceof KyootImpl;

export const succeed = (value: unknown): AnyKyoot => new KyootImpl({ _tag: "pure", value });

export const makeOp = (key: PropertyKey, payload: unknown, kont?: (v: any) => AnyKyoot) =>
  new KyootImpl({ _tag: "op", effectKey: key, payload, continuation: kont ?? ((v) => succeed(v)) });

export class DefectError {
  readonly _tag = "DefectError";
  readonly defect: unknown;
  constructor(defect: unknown) {
    this.defect = defect;
  }
}

export class EscapedOp {
  readonly _tag = "EscapedOp";
  readonly key: PropertyKey;
  readonly payload: unknown;
  readonly resume: (v: any) => AnyKyoot;
  readonly resumeError: (err: unknown) => AnyKyoot;
  constructor(
    key: PropertyKey,
    payload: unknown,
    resume: (v: any) => AnyKyoot,
    resumeError: (err: unknown) => AnyKyoot,
  ) {
    this.key = key;
    this.payload = payload;
    this.resume = resume;
    this.resumeError = resumeError;
  }
}

export class InterruptedError extends Error {
  readonly _tag = "InterruptedError";
  constructor(message = "fiber interrupted") {
    super(message);
    this.name = "InterruptedError";
  }
}

const isControl = (e: unknown) =>
  e instanceof DefectError || e instanceof EscapedOp || e instanceof InterruptedError;

export function invoke<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (isControl(e)) throw e;
    throw new DefectError(e);
  }
}

export async function invokeAsync<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (isControl(e)) throw e;
    throw new DefectError(e);
  }
}

export function stepAll(k: AnyKyoot): unknown {
  const continuations: Array<Continuation> = [];
  let current: AnyKyoot = k;

  while (true) {
    const currentNode = current[NodeSym];
    switch (currentNode._tag) {
      case "pure": {
        const f = continuations.pop();
        if (f === undefined) return currentNode.value;
        const out = invoke(() => f(currentNode.value));
        current = isKyoot(out) ? out : succeed(out);
        break;
      }
      case "map": {
        continuations.push(currentNode.mapper);
        current = currentNode.self;
        break;
      }
      case "gen": {
        const { factory, trace, cache } = currentNode;
        let gen = cache.live;
        let inputs: unknown[];
        if (gen !== null) {
          cache.live = null;
          inputs = [trace === null ? undefined : trace.input];
        } else {
          gen = invoke(factory);
          inputs = [];
          for (let t = trace; t !== null; t = t.prev) inputs.push(t.input);
          inputs.push(undefined);
          inputs.reverse();
        }
        const g = gen;
        let step!: IteratorResult<AnyKyoot, unknown>;
        for (let i = 0; i < inputs.length; i++) {
          const input = inputs[i];
          step = invoke(() => g.next(input));
          if (step.done === true && i < inputs.length - 1) {
            throw new DefectError(
              new Error("generator replay diverged — generator bodies must be pure between yields"),
            );
          }
        }
        if (step.done === true) {
          current = succeed(step.value);
        } else {
          const point: GenCache = { live: g };
          continuations.push(
            (input) =>
              new KyootImpl({ _tag: "gen", factory, trace: { input, prev: trace }, cache: point }),
          );
          current = step.value;
        }
        break;
      }
      case "op": {
        const captured = continuations.splice(0);
        const wrap = (inner: AnyKyoot): AnyKyoot => {
          for (let i = captured.length - 1; i >= 0; i--) {
            inner = new KyootImpl({ _tag: "map", self: inner, mapper: captured[i]! });
          }
          return inner;
        };
        throw new EscapedOp(
          currentNode.effectKey,
          currentNode.payload,
          (v) => wrap(invoke(() => currentNode.continuation(v))),
          (err) => wrap(new KyootImpl({ _tag: "raise", error: err })),
        );
      }
      case "raise": {
        throw currentNode.error;
      }
      case "handler": {
        const handler = currentNode;
        let inner: unknown;
        try {
          inner = stepAll(handler.self);
        } catch (e) {
          if (e instanceof InterruptedError) {
            if (handler.onInterrupt !== undefined) {
              try {
                invoke(() => handler.onInterrupt!(handler.state));
              } catch {}
            }
            throw e;
          }
          const { onDefect } = handler;
          if (e instanceof DefectError && onDefect !== undefined) {
            current = invoke(() => onDefect(e.defect, handler.state));
            break;
          }
          if (!(e instanceof EscapedOp)) throw e;
          if (e.key === handler.effectKey) {
            current = invoke(() =>
              handler.onOp(
                e.payload,
                (v, ...next) =>
                  new KyootImpl({
                    ...handler,
                    self: e.resume(v),
                    state: next.length > 0 ? next[0] : handler.state,
                  }),
                handler.state,
              ),
            );
            break;
          }
          throw new EscapedOp(
            e.key,
            e.payload,
            (v) => new KyootImpl({ ...handler, self: e.resume(v) }),
            (err) => new KyootImpl({ ...handler, self: e.resumeError(err) }),
          );
        }
        current = invoke(() => handler.onSuccess(inner, handler.state));
        break;
      }
    }
  }
}
