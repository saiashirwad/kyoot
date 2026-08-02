import { NodeSym, type AnyKyoot, type Kyoot, type RuntimeNode } from "./model.ts";
import { pipeArguments } from "./pipe.ts";
import type { Row } from "./types.ts";

export type { AnyKyoot, Kyoot, OnOp } from "./model.ts";

export class KyootImpl<A, S extends Row = {}> implements Kyoot<A, S> {
  readonly [NodeSym]: RuntimeNode;

  constructor(node: RuntimeNode) {
    this[NodeSym] = node;
  }

  map(f: (a: any) => any): AnyKyoot {
    return new KyootImpl({ _tag: "map", self: this as AnyKyoot, f });
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

export const makeOp = (key: string, payload: unknown, kont?: (v: any) => AnyKyoot) =>
  new KyootImpl({ _tag: "op", key, payload, kont: kont ?? ((v) => succeed(v)) });

const makeGenCont = (gen: Generator<AnyKyoot, any, unknown>, input: unknown): AnyKyoot =>
  new KyootImpl({ _tag: "gencont", gen, input });

export class DefectError {
  readonly _tag = "DefectError";
  readonly defect: unknown;
  constructor(defect: unknown) {
    this.defect = defect;
  }
}

export class EscapedOp {
  readonly _tag = "EscapedOp";
  readonly key: string;
  readonly payload: unknown;
  readonly resume: (v: any) => AnyKyoot;
  constructor(key: string, payload: unknown, resume: (v: any) => AnyKyoot) {
    this.key = key;
    this.payload = payload;
    this.resume = resume;
  }
}

const isControl = (e: unknown) => e instanceof DefectError || e instanceof EscapedOp;

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

type Kont = (v: any) => AnyKyoot;

export function stepAll(k: AnyKyoot): unknown {
  const konts: Array<Kont> = [];
  let current: AnyKyoot = k;

  while (true) {
    const currentNode = current[NodeSym];
    switch (currentNode._tag) {
      case "pure": {
        const f = konts.pop();
        if (f === undefined) return currentNode.value;
        const out = invoke(() => f(currentNode.value));
        current = isKyoot(out) ? out : succeed(out);
        break;
      }
      case "map": {
        konts.push(currentNode.f);
        current = currentNode.self;
        break;
      }
      case "gen": {
        current = makeGenCont(invoke(currentNode.f), undefined);
        break;
      }
      case "gencont": {
        const { gen } = currentNode;
        const step = invoke(() => gen.next(currentNode.input));
        if (step.done === true) {
          current = succeed(step.value);
        } else {
          konts.push((input) => new KyootImpl({ _tag: "gencont", gen, input }));
          current = step.value;
        }
        break;
      }
      case "op": {
        const captured = konts.splice(0);
        let used = false;
        throw new EscapedOp(currentNode.key, currentNode.payload, (v) => {
          if (used) {
            throw new DefectError(new Error("continuation resumed twice (one-shot law)"));
          }
          used = true;
          let resumed = invoke(() => currentNode.kont(v));
          for (let i = captured.length - 1; i >= 0; i--) {
            resumed = new KyootImpl({ _tag: "map", self: resumed, f: captured[i]! });
          }
          return resumed;
        });
      }
      case "handler": {
        let inner: unknown;
        try {
          inner = stepAll(currentNode.self);
        } catch (e) {
          const { onDefect } = currentNode;
          if (e instanceof DefectError && onDefect !== undefined) {
            current = invoke(() => onDefect(e.defect));
            break;
          }
          if (!(e instanceof EscapedOp)) throw e;
          if (e.key === currentNode.key) {
            const handler = currentNode;
            current = invoke(() =>
              currentNode.onOp(
                e.payload,
                (v) => new KyootImpl({ ...handler, _tag: "handler", self: e.resume(v) }),
              ),
            );
            break;
          }
          throw new EscapedOp(
            e.key,
            e.payload,
            (v) => new KyootImpl({ ...currentNode, self: e.resume(v) }),
          );
        }
        current = invoke(() => currentNode.onPure(inner));
        break;
      }
    }
  }
}
