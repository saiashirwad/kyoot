import type { Merge, Row, Simplify } from "./types.ts";
import { pipeArguments, type Pipeable } from "./pipe.ts";

export type AnyKyoot = Kyoot<any, any>;

export type OnOp = (payload: any, resume: (v: any) => AnyKyoot) => AnyKyoot;

type Node =
  | { readonly _tag: "pure"; readonly value: unknown }
  | {
      readonly _tag: "op";
      readonly key: string;
      readonly payload: unknown;
      readonly kont: (v: any) => AnyKyoot;
    }
  | { readonly _tag: "map"; readonly self: AnyKyoot; readonly f: (a: any) => any }
  | {
      readonly _tag: "handler";
      readonly key: string;
      readonly self: AnyKyoot;
      readonly onOp: OnOp;
      readonly onPure: (a: any) => AnyKyoot;
      readonly onDefect?: (d: unknown) => AnyKyoot;
    }
  | { readonly _tag: "gen"; readonly f: () => Generator<AnyKyoot, any, unknown> }
  | {
      readonly _tag: "gencont";
      readonly it: Generator<AnyKyoot, any, unknown>;
      readonly input: unknown;
    };

const nodeSym: unique symbol = Symbol("kyoot.node");

export interface Kyoot<A, S extends Row = {}> extends Pipeable {
  readonly _?: (s: S) => void;

  readonly [nodeSym]: Node;

  map<B, S2 extends Row = {}>(f: (a: A) => B | Kyoot<B, S2>): Kyoot<B, Simplify<Merge<S, S2>>>;

  [Symbol.iterator](): Iterator<Kyoot<unknown, S>, A, unknown>;
}

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

export const isKyoot = (x: unknown): x is AnyKyoot => x instanceof KyootImpl;

export const pureKyoot = (value: unknown): AnyKyoot => new KyootImpl({ _tag: "pure", value });

export const opKyoot = (key: string, payload: unknown, kont?: (v: any) => AnyKyoot) =>
  new KyootImpl({ _tag: "op", key, payload, kont: kont ?? ((v) => pureKyoot(v)) });

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

export function callUser<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (isControl(e)) throw e;
    throw new DefectError(e);
  }
}

async function callUserAsync<T>(f: () => Promise<T>): Promise<T> {
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
        const out = callUser(() => f(node.value));
        current = isKyoot(out) ? out : pureKyoot(out);
        break;
      }
      case "map": {
        konts.push(node.f);
        current = node.self;
        break;
      }
      case "gen": {
        const it = callUser(node.f);
        current = new KyootImpl({ _tag: "gencont", it, input: undefined });
        break;
      }
      case "gencont": {
        const step = callUser(() => node.it.next(node.input));
        if (step.done === true) {
          current = pureKyoot(step.value);
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
          let n = callUser(() => node.kont(v));
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
            current = callUser(() => onDefect(e.defect));
            break;
          }
          if (!(e instanceof EscapedOp)) throw e;
          if (e.key === node.key) {
            const h = node;
            const onOp = h.onOp;
            current = callUser(() =>
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
        current = callUser(() => node.onPure(inner));
        break;
      }
    }
  }
}

export function succeed<A>(a: A): Kyoot<A> {
  return new KyootImpl({ _tag: "pure", value: a });
}

export function runSync<A>(k: Kyoot<A, {}>): A {
  try {
    return stepAll(k as AnyKyoot) as A;
  } catch (e) {
    if (e instanceof DefectError) throw e.defect;
    if (e instanceof EscapedOp) {
      throw new Error(`runSync encountered unhandled effect '${e.key}'`);
    }
    throw e;
  }
}

export interface AsyncRuntime {
  readonly signal: AbortSignal;
  spawn(k: AnyKyoot): { readonly promise: Promise<unknown> };
}

export interface AsyncOp {
  execute(rt: AsyncRuntime): Promise<unknown>;
}

export async function asyncDrive(k: AnyKyoot, rt: AsyncRuntime): Promise<unknown> {
  let current = k;
  while (true) {
    try {
      return stepAll(current);
    } catch (e) {
      if (e instanceof EscapedOp && e.key === "async") {
        const v = await callUserAsync(() => (e.payload as AsyncOp).execute(rt));
        current = e.resume(v);
      } else {
        throw e;
      }
    }
  }
}

export function runPromise<A>(k: Kyoot<A, {}>): Promise<A>;
export function runPromise<A>(k: Kyoot<A, { async: true }>): Promise<A>;
export function runPromise<A>(k: AnyKyoot): Promise<A> {
  const controller = new AbortController();
  const rt: AsyncRuntime = {
    signal: controller.signal,
    spawn: (k2) => ({ promise: asyncDrive(k2, rt) }),
  };
  return (asyncDrive(k as AnyKyoot, rt) as Promise<A>).catch((e: unknown): never => {
    if (e instanceof DefectError) throw e.defect;
    if (e instanceof EscapedOp) {
      throw new Error(`runPromise encountered unhandled effect '${e.key}'`);
    }
    throw e;
  });
}
