# Stream — implementation handoff

The next big piece for kyoot: pull-based "values over time." This document is
the whole briefing — read it before writing any code.

## Where this sits in the roadmap

1. ~~Resource — acquire/release with guaranteed cleanup~~ — done
2. ~~Interruption + structured concurrency~~ — done
3. ~~`Async.all` / parallel `forEach`~~ — done. `all` takes the array form
   only (records deferred); parallel `forEach` is `all(ks).map(() =>
undefined)` at the call site. Fail-fast: first failure interrupts the
   rest and waits for them to unwind before the error propagates.
4. **Stream** — this document.

## What Stream is (and is not)

Stream is for values that arrive over time, possibly unbounded, where the
consumer drives the pace: paginated APIs, queues, websockets, file lines.

It is NOT Choice. `Choice.get([1,2,3])` eagerly explores a fixed, finite
option set and collects all branches. Stream is lazy, pull-based, and can be
infinite.

It is NOT Emit. Emit is fire-and-forget output — the producer doesn't care
who listens. Stream elements are data; transforming and composing a stream
before consuming it is the whole point. Kyo keeps both; kyoot should too.
(Fun fact: kyoot's emit handlers already give you suspension-based pull — a
producer yielding `Emit.value(x)` parks until the handler resumes it. Stream
formalizes that into a composable type.)

## Recommended design

**A Stream is a Kyoot that emits.** No new core machinery:

```ts
export type Stream<A, S extends Row = {}> = Kyoot<void, S & { emit: A }>;
```

Transformers are emit handlers; sinks are emit eliminators. This rides
everything already built: handler state threading, multi-shot safety, the
nesting laws, Resource, interruption.

### Phase 1 — sync streams (zero core changes, ~150 lines)

`src/effects/stream.ts`:

- Sources: `fromIterable`, `unfold`, `range`? (keep to the first two)
- Transformers (each an emit handler that re-emits downstream):
  `map`, `filter`, `take`, `drop`, `concat`
- Sinks (aliases over Emit eliminators):
  `runCollect` (= `Emit.run`), `runForEach` (= `Emit.forEach`),
  `runFold`, `runDrain` (= `Emit.discard`), `runHead`

Key mechanics, already proven in the codebase:

- **Laziness is free.** The producer suspends at each emitted element until
  the transformer/sink resumes it. `take(3)` on an infinite source terminates
  because `take` short-circuits (returns `succeed` without resuming) once the
  budget is spent.
- **Re-emitting downstream from a transformer**: inside `onOp`, return
  `makeOp("emit", mapped).map(() => resume(undefined, nextState))`. The emit
  op escapes to the next handler outward. This path is safe — see "the
  re-escape fix" below.
- **Early termination + Resource**: the correct pipe order is
  `source.pipe(...transformers, Resource.run(), sink)`. `Resource.run` must
  sit outside any short-circuiting transformer (like `take`), or finalizers
  of a terminated producer are silently skipped. This is the same nesting
  law as Fail; pin it in tests.

### Phase 2 — async streams (needs the fiber layer)

- `fromAsyncIterable`
- `mapAsync` / `mapPar(n)`: per-element async work with a concurrency bound.
  Requires a **bounded Queue** (producer blocks when full = backpressure).
  Queue is its own primitive (Kyo has one); build it on fibers +
  `Async.suspend`. Producer runs in a child fiber; structured concurrency
  interrupts it when the consumer finishes or the stream is cut short.
- Do NOT build Hub (broadcast) — defer until a real use case exists.

### Explicit non-goals

- No fusion/optimization passes. Element-at-a-time is fine; chunking is a
  perf refinement for later, not a semantic one.
- No Effect-style Channel internals. The emit-handler encoding is the
  design; if it can't express something, say so in the doc rather than
  growing a second interpreter.

## Laws you must respect (hard-won, all pinned by tests)

Read these source files first: `src/core.ts` (stepAll), `src/handler.ts`,
`src/effects/resource.ts`, `src/effects/emit.ts`, `src/effects/async.ts`.

- **Handlers are ordinary effects.** op + `makeHandler`, row-keyed. New
  behavior goes in a new effect file, not in the core.
- **Handler state is immutable.** Thread it with `resume(value, nextState)`;
  each resumption is an independent branch (multi-shot). Never close over a
  mutable accumulator.
- **Nesting law.** `Resource.run()` goes OUTSIDE short-circuiting handlers
  (`Fail.run`, `Choice.run`, `Stream.take`); they drop continuations and
  would silently skip finalizers. The fail tests ("handler order: …") pin
  this style.
- **Choice law.** Effects fired inside a Choice branch must be handled
  inside the Choice region — this includes async ops and stream ops.
- **Purity law.** Generator bodies must be pure between yields; replay
  re-runs them (that's how multi-shot works).
- **The re-escape fix.** An op escaping through a _yielded_ handler node to
  an outer handler now carries the outer continuation with it
  (`src/core.ts`, the mismatch branch of the handler case). Stream
  transformers rely on this shape — the core regression test "an op escaping
  a yielded handler node keeps the outer continuation" must keep passing.
- **Interruption is cooperative**, at await points. Async sources must honor
  the `AbortSignal` they get from `Async.suspend` (see how `Async.sleep`
  cancels its timer). Interrupted producers unwind through `onInterrupt` and
  run Resource finalizers.
- **Fibers**: must be handled down to async-only (`AsyncOnly` enforces it at
  the type level). A completed parent interrupts its children and waits for
  them to unwind before `runPromise` resolves.

## House rules (do not skip)

- `pnpm typecheck` (tsc), `pnpm test` (node --test), `pnpm format` (oxfmt).
  All three must pass before calling anything done.
- **No comments in code, ever.** The human writes all comments. If a law
  needs documenting, tell the human in your reply; do not write it in the
  file.
- **No TypeScript parameter properties** (`constructor(readonly x: T)`).
  Node's strip-only TS mode rejects them; declare fields explicitly (see
  `FiberImpl` in `src/effects/async.ts`).
- Tests live in `test/`, style: `node:test` + `node:assert/strict`. Type-level
  pins go in `test/types.test-d.ts` (checked by tsc, never executed).
- Examples live in `examples/`, must actually run (`node examples/x.ts`).
- When the suite mysteriously waits ~10s: an interrupted timer isn't being
  cancelled. Async primitives must clear their timers on the abort signal.

## Test plan for Phase 1

- `runCollect` over `fromIterable` returns all elements in order.
- Laziness: `take(2)` on an instrumented infinite source runs the producer
  exactly twice.
- `map`/`filter` compose and preserve order.
- Early termination runs producer finalizers (correct pipe order) — and a
  test documenting the wrong order, if you choose to pin it like the
  Var/Fail ordering tests.
- `runHead` on empty stream → whatever the chosen empty semantics is (decide
  and document: `undefined`? typed failure?).
- Type pins: transformer rows accumulate, sink eliminates `emit`.

## Open questions (decide before or during Phase 1)

1. **Is `Stream = Kyoot that emits` enough?** The `emit` row is a single
   channel — two streams can't be in flight in one program. Acceptable for
   minimal (Var-style tagged keys could lift it later). If this bothers you,
   say so before starting; it changes the encoding.
2. **`runHead` empty semantics** — `undefined` vs typed failure in `fail`.
3. **Does `take(0)` emit zero and short-circuit immediately?** (Yes is the
   sane answer; pin it.)
