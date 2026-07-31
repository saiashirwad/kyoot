import type { Merge, Row, Simplify } from './types.ts'

export type AnyKyoot = Kyoot<any, any>

// ---------------------------------------------------------------------------
// Runtime representation.
//
// Two conceptual node kinds (per the design doc): Pure holds a value, Op
// holds an effect key, a payload, and a continuation. `map`, `handler`,
// `gen`/`gencont` are internal plumbing around those two.
// ---------------------------------------------------------------------------

export type OnOp = (payload: any, resume: (v: any) => AnyKyoot) => AnyKyoot

export type Node =
  | { readonly _tag: 'pure'; readonly value: unknown }
  | { readonly _tag: 'op'; readonly key: string; readonly payload: unknown; readonly kont: (v: any) => AnyKyoot }
  | { readonly _tag: 'map'; readonly self: AnyKyoot; readonly f: (a: any) => any }
  | {
    readonly _tag: 'handler'
    readonly key: string
    readonly self: AnyKyoot
    readonly onOp: OnOp
    readonly onPure: (a: any) => AnyKyoot
    readonly onDefect?: (d: unknown) => AnyKyoot
  }
  | { readonly _tag: 'gen'; readonly f: () => Generator<AnyKyoot, any, unknown> }
  | { readonly _tag: 'gencont'; readonly it: Generator<AnyKyoot, any, unknown>; readonly input: unknown }

const nodeSym: unique symbol = Symbol('kyo.node')

// ---------------------------------------------------------------------------
// The pending type. `Kyo<A, S>` — a value `A` pending the effects in `S`.
// ---------------------------------------------------------------------------

export interface Kyoot<A, S extends Row = {}> {
  // Phantom keeping S from collapsing to plain covariance: with it, S is
  // measured invariant, so `Kyo<A, {}>` accepts only an exactly-empty row —
  // which is what makes `runSync(k: Kyo<A, {}>)` a compile-time totality
  // check instead of a cast.
  readonly _S?: (s: S) => void

  readonly [nodeSym]: Node

  // The single combinator. Auto-flattens: if f returns a Kyo, the rows merge.
  map<B, S2 extends Row = {}>(f: (a: A) => B | Kyoot<B, S2>): Kyoot<B, Simplify<Merge<S, S2>>>

  // NOTE: a readonly property of overloaded function type, not method
  // shorthand — method parameters are bivariant, which would make S
  // bivariant too and let any two Kyo types mutually assign (collapsing
  // same-key rows via union reduction). Property syntax keeps S invariant.
  readonly pipe: {
    <B>(ab: (a: Kyoot<A, S>) => B): B
    <B, C>(ab: (a: Kyoot<A, S>) => B, bc: (b: B) => C): C
    <B, C, D>(ab: (a: Kyoot<A, S>) => B, bc: (b: B) => C, cd: (c: C) => D): D
    <B, C, D, E>(ab: (a: Kyoot<A, S>) => B, bc: (b: B) => C, cd: (c: C) => D, de: (d: D) => E): E
    <B, C, D, E, F>(
      ab: (a: Kyoot<A, S>) => B,
      bc: (b: B) => C,
      cd: (c: C) => D,
      de: (d: D) => E,
      ef: (e: E) => F,
    ): F
    <B, C, D, E, F, G>(
      ab: (a: Kyoot<A, S>) => B,
      bc: (b: B) => C,
      cd: (c: C) => D,
      de: (d: D) => E,
      ef: (e: E) => F,
      fg: (f: F) => G,
    ): G
    <B, C, D, E, F, G, H>(
      ab: (a: Kyoot<A, S>) => B,
      bc: (b: B) => C,
      cd: (c: C) => D,
      de: (d: D) => E,
      ef: (e: E) => F,
      fg: (f: F) => G,
      gh: (g: G) => H,
    ): H
  }

  // Enables yield* inside Kyo.gen. One-shot: yields the Kyo itself once,
  // then returns whatever the interpreter sends back.
  [Symbol.iterator](): Iterator<Kyoot<unknown, S>, A, unknown>
}

export class KyootImpl<A, S extends Row = {}> implements Kyoot<A, S> {
  readonly [nodeSym]: Node

  constructor(node: Node) {
    this[nodeSym] = node
  }

  map(f: (a: any) => any): AnyKyoot {
    return new KyootImpl({ _tag: 'map', self: this as AnyKyoot, f })
  }

  pipe(...fns: Array<(x: any) => any>): any {
    let x: any = this
    for (const f of fns) x = f(x)
    return x
  }

  [Symbol.iterator](): Iterator<Kyoot<unknown, S>, A, unknown> {
    let used = false
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    return {
      next(v: unknown): IteratorResult<Kyoot<unknown, S>, A> {
        if (used) return { done: true, value: v as A }
        used = true
        return { done: false, value: self as Kyoot<unknown, S> }
      },
    }
  }
}

export function isKyoot(x: unknown): x is AnyKyoot {
  return x instanceof KyootImpl
}

// Internal node constructors, used by gen.ts / handler.ts / effects/*.
export function pureKyoot(value: unknown): AnyKyoot {
  return new KyootImpl({ _tag: 'pure', value })
}

export function opKyoot(key: string, payload: unknown, kont?: (v: any) => AnyKyoot): AnyKyoot {
  return new KyootImpl({ _tag: 'op', key, payload, kont: kont ?? ((v) => pureKyoot(v)) })
}

// ---------------------------------------------------------------------------
// Defects and escaped ops.
//
// A `throw` from user code is not a typed failure — it is a defect. Every
// user-code call site is wrapped so defects funnel into one channel and are
// never swallowed. An op with no handler for its key escapes outward as an
// EscapedOp carrying its one-shot resumption.
// ---------------------------------------------------------------------------

export class DefectError {
  readonly _tag = 'DefectError'
  readonly defect: unknown
  constructor(defect: unknown) {
    this.defect = defect
  }
}

export class EscapedOp {
  readonly _tag = 'EscapedOp'
  readonly key: string
  readonly payload: unknown
  readonly resume: (v: any) => AnyKyoot
  constructor(key: string, payload: unknown, resume: (v: any) => AnyKyoot) {
    this.key = key
    this.payload = payload
    this.resume = resume
  }
}

function isControl(e: unknown): boolean {
  return e instanceof DefectError || e instanceof EscapedOp
}

export function callUser<T>(f: () => T): T {
  try {
    return f()
  } catch (e) {
    if (isControl(e)) throw e
    throw new DefectError(e)
  }
}

async function callUserAsync<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f()
  } catch (e) {
    if (isControl(e)) throw e
    throw new DefectError(e)
  }
}

// ---------------------------------------------------------------------------
// The interpreter. Trampolined: `map` continuations live on a heap stack,
// never the JS stack. Handlers are nested interpreter frames; an unhandled
// op escapes as a thrown EscapedOp, and every handler frame it passes
// through wraps the resumption so it re-enters that frame — delimited
// continuations via exceptions.
// ---------------------------------------------------------------------------

export function stepAll(k: AnyKyoot): unknown {
  const konts: Array<(v: any) => AnyKyoot> = []
  let current: AnyKyoot = k

  while (true) {
    const node = current[nodeSym]
    switch (node._tag) {
      case 'pure': {
        const f = konts.pop()
        if (f === undefined) return node.value
        const out = callUser(() => f(node.value))
        current = isKyoot(out) ? out : pureKyoot(out)
        break
      }
      case 'map': {
        konts.push(node.f)
        current = node.self
        break
      }
      case 'gen': {
        const it = callUser(node.f)
        current = new KyootImpl({ _tag: 'gencont', it, input: undefined })
        break
      }
      case 'gencont': {
        const step = callUser(() => node.it.next(node.input))
        if (step.done === true) {
          current = pureKyoot(step.value)
        } else {
          konts.push((v) => new KyootImpl({ _tag: 'gencont', it: node.it, input: v }))
          current = step.value
        }
        break
      }
      case 'op': {
        // Reify the remaining computation: the op's own continuation plus
        // the pending map/gen continuations, in order. One-shot by law —
        // a handler resumes zero times or one time, never twice.
        const captured = konts.splice(0)
        let used = false
        const resume = (v: any): AnyKyoot => {
          if (used) {
            throw new DefectError(new Error('continuation resumed twice (one-shot law)'))
          }
          used = true
          let n = callUser(() => node.kont(v))
          for (let i = captured.length - 1; i >= 0; i--) {
            n = new KyootImpl({ _tag: 'map', self: n, f: captured[i]! })
          }
          return n
        }
        throw new EscapedOp(node.key, node.payload, resume)
      }
      case 'handler': {
        let inner: unknown
        try {
          inner = stepAll(node.self)
        } catch (e) {
          if (e instanceof DefectError && node.onDefect !== undefined) {
            const onDefect = node.onDefect
            current = callUser(() => onDefect(e.defect))
            break
          }
          if (!(e instanceof EscapedOp)) throw e
          if (e.key === node.key) {
            // Intercept. Resumption re-enters this handler frame, so further
            // ops for this key are intercepted again; not resuming
            // short-circuits (onPure never sees the result).
            const h = node
            const onOp = h.onOp
            current = callUser(() =>
              onOp(e.payload, (v) => new KyootImpl({ ...h, _tag: 'handler', self: e.resume(v) })),
            )
            break
          }
          // Not ours: propagate outward, but wrap the resumption so it
          // passes back through this frame.
          const h = node
          throw new EscapedOp(
            e.key,
            e.payload,
            (v) => new KyootImpl({ ...h, _tag: 'handler', self: e.resume(v) }),
          )
        }
        current = callUser(() => node.onPure(inner))
        break
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Edges.
// ---------------------------------------------------------------------------

export function succeed<A>(a: A): Kyoot<A> {
  return new KyootImpl({ _tag: 'pure', value: a })
}

// runSync only accepts an empty effect row — checked in the types.
// (The doc's `Kyo<A, S> & Empty<S>` spelling works too, but routing
// inference through the intersection makes contextual instantiation of the
// pipeline upstream fall back to constraints; the plain `Kyo<A, {}>`
// parameter infers cleanly and rejects the same programs.)
export function runSync<A>(k: Kyoot<A, {}>): A {
  try {
    return stepAll(k as AnyKyoot) as A
  } catch (e) {
    if (e instanceof DefectError) throw e.defect
    if (e instanceof EscapedOp) {
      throw new Error(`runSync encountered unhandled effect '${e.key}'`)
    }
    throw e
  }
}

// The async runtime handed to async ops at the edge. `signal` exists from
// day one so tier-2 interruption does not break effect signatures.
export interface AsyncRuntime {
  readonly signal: AbortSignal
  spawn(k: AnyKyoot): { readonly promise: Promise<unknown> }
}

export interface AsyncOp {
  execute(rt: AsyncRuntime): Promise<unknown>
}

export async function asyncDrive(k: AnyKyoot, rt: AsyncRuntime): Promise<unknown> {
  let current = k
  while (true) {
    try {
      return stepAll(current)
    } catch (e) {
      if (e instanceof EscapedOp && e.key === 'async') {
        const v = await callUserAsync(() => (e.payload as AsyncOp).execute(rt))
        current = e.resume(v)
      } else {
        throw e
      }
    }
  }
}

// runPromise only accepts a row containing at most `async` — checked in the
// types. (Effect checks this at runtime; we check it in the types.) Two
// overloads, since our rows are always fully-evaluated object types: a
// fully-handled program (`{}`) or one pending only `async`.
export function runPromise<A>(k: Kyoot<A, {}>): Promise<A>
export function runPromise<A>(k: Kyoot<A, { async: true }>): Promise<A>
export function runPromise<A>(k: AnyKyoot): Promise<A> {
  const controller = new AbortController()
  const rt: AsyncRuntime = {
    signal: controller.signal,
    spawn: (k2) => ({ promise: asyncDrive(k2, rt) }),
  }
  return (asyncDrive(k as AnyKyoot, rt) as Promise<A>).catch((e: unknown): never => {
    if (e instanceof DefectError) throw e.defect
    if (e instanceof EscapedOp) {
      throw new Error(`runPromise encountered unhandled effect '${e.key}'`)
    }
    throw e
  })
}
