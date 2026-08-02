import { nodeSym, type AnyKyoot, type Kyoot, type Node } from "./model.ts";
import { pipeArguments } from "./pipe.ts";
import type { Row } from "./types.ts";

export type { AnyKyoot, Kyoot, OnOp } from "./model.ts";

export class KyootImpl<A, S extends Row = {}> implements Kyoot<A, S> {
  readonly [nodeSym]: Node;

  constructor(node: Node) {
    this[nodeSym] = node;
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

export function stepAll(k: AnyKyoot): unknown {
  const konts: Array<(v: any) => AnyKyoot> = [];
  let current: AnyKyoot = k;

  while (true) {
    const node = current[nodeSym];
    switch (node._tag) {
      case "pure": {
        const f = konts.pop();
        if (f === undefined) return node.value;
        const out = invoke(() => f(node.value));
        current = isKyoot(out) ? out : succeed(out);
        break;
      }
      case "map": {
        konts.push(node.f);
        current = node.self;
        break;
      }
      case "gen": {
        const it = invoke(node.f);
        current = new KyootImpl({ _tag: "gencont", it, input: undefined });
        break;
      }
      case "gencont": {
        const step = invoke(() => node.it.next(node.input));
        if (step.done === true) {
          current = succeed(step.value);
        } else {
          konts.push((v) => new KyootImpl({ _tag: "gencont", it: node.it, input: v }));
          current = step.value;
        }
        break;
      }
      case "op": {
        const captured = konts.splice(0);
        let used = false;
        const resume = (v: any): AnyKyoot => {
          if (used) {
            throw new DefectError(new Error("continuation resumed twice (one-shot law)"));
          }
          used = true;
          let n = invoke(() => node.kont(v));
          for (let i = captured.length - 1; i >= 0; i--) {
            n = new KyootImpl({ _tag: "map", self: n, f: captured[i]! });
          }
          return n;
        };
        throw new EscapedOp(node.key, node.payload, resume);
      }
      case "handler": {
        let inner: unknown;
        try {
          inner = stepAll(node.self);
        } catch (e) {
          if (e instanceof DefectError && node.onDefect !== undefined) {
            const onDefect = node.onDefect;
            current = invoke(() => onDefect(e.defect));
            break;
          }
          if (!(e instanceof EscapedOp)) throw e;
          if (e.key === node.key) {
            const h = node;
            const onOp = h.onOp;
            current = invoke(() =>
              onOp(e.payload, (v) => new KyootImpl({ ...h, _tag: "handler", self: e.resume(v) })),
            );
            break;
          }
          const h = node;
          throw new EscapedOp(
            e.key,
            e.payload,
            (v) => new KyootImpl({ ...h, _tag: "handler", self: e.resume(v) }),
          );
        }
        current = invoke(() => node.onPure(inner));
        break;
      }
    }
  }
}
