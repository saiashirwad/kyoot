# How Kyo keeps effects and state across forks

Research for [kyoot #21](https://github.com/saiashirwad/kyoot/issues/21), feeding [the kernel rewrite map](https://github.com/saiashirwad/kyoot/issues/20).

## Answer

Kyo does **not copy the parent's arbitrary operation handlers into a child fiber**. It copies context regions under their explicit fork policies, and requires an `Isolate` for other pending effects. An isolate captures state in the caller, installs an effect-specific handler in the child, and returns a transformed result whose restoration runs when the result is consumed. Services such as Clock, Log and Random are ambient `Local` values, not their own arrow effects. `Abort` is an ordinary arrow effect implemented above the kernel; the scheduler knows about it. Interruption enters the kernel through generic safepoint stop/park and region-release machinery, not an Abort-specific evaluator case. [S1–S8, S10–S14]

**Important version correction:** this investigation pins `getkyo/kyo` `main` at [`20473af365ba818f161c370ef22e2f81c1f377ff`](https://github.com/getkyo/kyo/commit/20473af365ba818f161c370ef22e2f81c1f377ff), fetched 2026-10-01. At this revision there is no public `Isolate.Stateful` / `Isolate.Contextual` pair and no `Async.run` entry point. The public abstraction is `Isolate[Remove, Keep, Restore]`; `Contextual` is an internal crossing component. The current fork APIs are `Fiber.init`, `Fiber.initUnscoped` and the `.fork` family. Describing the older names as current APIs would mislead the implementation tickets. [S1, S4, S5, S9]

## 1. Two kinds of propagation, not a cloned handler stack

### Contextual propagation

`Stack.contextual()` explicitly selects **only** `Handler.ContextHandler` entries. Its snapshot stores the handler and state, an identity continuation, and no inherited release obligation. It is not a snapshot of all arrow handlers or the parent's continuation. [S2]

At an actual fiber crossing, `isolate.crossing` composes the internal `Contextual` isolate before the effect-specific isolate:

1. `capture` requests the current evaluator stack and extracts its contextual snapshot.
2. `isolate` wraps each context handler with a distinct `Forked` identity, calls the originating handler's `fork(parentState)`, and installs the snapshot using `Pending.Park` around the child body.
3. On successful completion it captures final context state and returns `(forkedStart, childFinals, result)`.
4. `restore` finds each **originating handler by identity in the consuming stack**, calls `join(currentParent, forkedStart, childFinal)`, and updates that stack's state. If the origin is no longer present, it does not invent a new parent binding. [S1, lines 209–217 and 262–350]

An ordinary `Isolate.run` in the same fiber is not itself a crossing. The derivation starts from an identity isolate; the spawn site adds `.crossing` once, preserving the same instance across capture and isolate. The Local tests explicitly distinguish in-place isolation from crossing, including non-inheritable locals. [S1; S15]

### Stateful/effect-specific propagation

The current public `Isolate` contract is:

```scala
abstract class Isolate[Remove, -Keep, -Restore]:
    type State
    type Transform[_]
    def capture[A, S](f: State => A < S): A < (Remove & S)
    def isolate[A, S](state: State, v: A < (S & Remove)): Transform[A] < (Keep & S)
    def restore[A, S](v: Transform[A] < S): A < (Restore & S)
```

`Frame` parameters are omitted above for readability. `Remove` names effects satisfied by isolation; `Keep` names effects the isolated execution may still perform; `Restore` names effects needed to consume the transformed result. `capture` may itself perform the original effect, which is why spawning does not simply erase that effect from the caller's row. [S1, lines 80–157; D1]

`Var` is a concrete example, not a kernel special case:

- capture with `Var.use`;
- run the child under `Var.runTuple(capturedState)`, returning `(finalState, value)`;
- explicitly choose `Var.isolate.update` (set the consuming Var), `merge(f)` (combine current and final state), or `discard` (drop child state).

There is **no default Var isolation strategy**. Lost child writes are therefore an explicit discard policy, not a necessary consequence of forking. Nor is Var a shared concurrent mutable cell. [S3, lines 197–257; D2]

Isolate derivation composes the required instances for intersection rows, subtracts `Keep`, and skips `ContextEffect` subtypes because the crossing mechanism handles them. Missing instances are compile-time errors; arbitrary operation handlers are not silently carried along. The derivation also rejects `Isolate.Disallowed` (`Region.NoEscape`) **before** subtracting `Keep`: a continuation handed to a handler clause cannot be sent to another fiber. [S1, lines 352–443; D1]

## 2. `ContextEffect` and `Local`

A `ContextEffect[A]` declares a dynamically bound value, whereas an `ArrowEffect` declares operations. A required context read puts the effect in the row; a read with a default does not. Context handlers own the crossing policy:

| Handler | Child starts with | Parent after restoration |
|---|---|---|
| `handleInheritable` | Same value/reference | Keeps parent value |
| `handleNonInheritable` | `derive(Absent)` — region starts over | Keeps parent value |
| `handle` | Explicit `fork(parent)` | Explicit `join(parent, forkStart, childEnd)` |

The full handler also has `release(state, failure)` for region lifetime. “Non-inheritable” at this level does **not** mean the binding disappears: the region crosses with a newly derived neutral state. [S6, lines 125–231; D1]

`Local[A]` builds on a private `ContextEffect[Map[Local[?], AnyRef]]`. All locals share that context tag; `get`/`use` look up the Local identity in the map and fall back to its default. `let` and `update` create scoped context bindings rather than an unscoped mutable assignment. No Local requirement appears in their effect row. [S7, lines 36–115 and 166–168; D2]

Each Local supplies a per-value policy:

- `Local.init(default)` inherits the value and retains the parent's value on join.
- `Local.initNoninheritable(default)` returns `Absent` from its fork policy, omitting that local from the child map so reads use the default.
- `Local.init(default)(forkValue, joinValue)` can transform the value or customize restoration.

The map-level context handler applies these policies. Its Local join callback receives the parent's value and the child's final value (the map-level three-argument join deliberately ignores fork-start). This is **reference propagation, not recursive object cloning**: inheriting a mutable service reference shares that service, even though rebinding the Local remains scoped. [S7; S15; D2]

## 3. What spawning requires of the effect row

At the pinned revision, `.fork` is an extension on:

```scala
A < (Abort[E] & Async & S)
```

It requires `Isolate[S, Sync, S2]`, `Reducible[Abort[E]]`, and `Frame`, and returns:

```scala
Fiber[A, reduce.SReduced & S2] < (Sync & S & Scope)
```

`.forkUnscoped` / `Fiber.initUnscoped` omit `Scope` from the spawn result. `.forkUsing` / `Fiber.use` bracket use of the handle with interruption. `Fiber.init` gives the child its own scope and registers eventual interruption with the enclosing scope. These lifecycle guarantees are separate from state isolation. [S4, lines 122–194; S5, lines 10–51; D3]

The body may contain Async and Abort because the task boundary handles them, not because the parent Async or Abort handler is copied. `S` must be isolatable under the stated `Keep = Sync` constraint; contexts qualify automatically, while additional arrow effects need appropriate instances or must be handled within the submitted computation. `Abort[Nothing]` is reducible away. Other concurrency APIs have different constraints: for example `Async` combinators use `Isolate[S, Abort[E] & Async, S]`. Do not impose a single universal row signature on every concurrency operation. [S1, S4, S5, S8, S9, S10]

The actual path is:

```text
fork -> Fiber.init -> Fiber.initUnscoped
     -> crossing.capture in caller
     -> IOTask(crossing)(captured, body)
     -> task boundary(crossing.isolate(captured, body))
     -> successful promise contains crossing.restore(transformedResult)
     -> Fiber.get consumes that pending result in the joining computation
```

`IOTask` stores `A < S2` inside its promise. `Fiber.get` evaluates that nested computation through `Async.use(...)(identity)`. Thus restoration is associated with **consuming a successful result**, not an asynchronous write into the parent at the instant the child finishes. An unjoined fiber should not be assumed to update parent state. Nor should failure/interruption be assumed to run success-path restoration: the task boundary completes its error branch without calling the successful `restore` function. [S4, lines 255–296; S8]

The docs warn that short-circuit effects such as Abort and Choice should not provide automatically derived isolation because handler ordering changes semantics. That does **not** forbid Abort in an async body: it is explicitly handled by the fiber boundary. [D1; S8; S10]

## 4. Clock, Log and Random are Local services

| Service | Implementation | Fork implication |
|---|---|---|
| Clock | `private val local = Local.init(live)`; `Clock.let` rebinds it; operations use `Sync.Unsafe.withLocal` and an unsafe backend. | Child inherits the selected clock object, including an override. Time reads are Sync operations; sleeping can additionally await asynchronously. |
| Log | `private val local = Local.init(live)`; `Log.let` substitutes a logger; logging delegates through `Sync.Unsafe.withLocal`. | Child inherits logger selection; logging is not an operation dispatched to a distinct `Log` arrow-effect handler. |
| Random | `private val local = Local.init(live)`; `Random.let` substitutes a service; `withSeed` creates `new java.util.Random(seed)` inside Sync. | Child inherits the **same RNG service reference**, not a copied numeric seed or cloned generator state. |

These are service objects with methods whose rows express Sync/Async as appropriate, not three additional `ArrowEffect` families. `Sync.Unsafe.withLocal` gets the ambient value through Local and defers the unsafe operation. [S11–S14; D3]

**Consequence for kyoot's reported duplicated seeded number:** Kyo's default Local inheritance does not create two generators at the same point in a seed sequence. A seeded parent and child consume the shared generator instance; scheduling can affect which fiber receives which draw. This conclusion follows from the constructors and identity-preserving Local fork implementation, not from a test that promises deterministic concurrent ordering. Do not claim that every mutable service is safe for concurrent access: Kyo's own Clock docs warn that `Clock.TimeControl` is not thread-safe. [S7, S13; D3]

## 5. Abort and interruption: where the boundary really is

### Abort is not a kernel opcode

`Abort[-E]` lives in `kyo-prelude` and extends `ArrowEffect[Const[Result.Error[E]], Const[Unit]]`. `Abort.error` suspends under an erased Abort tag; `runWith` uses the generic `ArrowEffect.handleCont` API, returns the error without resuming the continuation, and re-raises unaccepted typed errors outside that handler. Its exception callback implements conversion of throws into failures/panics. The evaluator supplies generic dispatch, continuation and unwind machinery, rather than importing Abort to recognize failure. [S10; S16]

The **scheduler** is deliberately less generic: `IOTask.boundary` handles the union tag `Async.Join & Abort[Any]`. It recognizes `Result.Error` to settle the fiber and join inputs to await a promise. This is an effect-aware runtime boundary in `kyo-core`, not Abort coupling in `kyo-kernel`. [S8]

### Interruption reaches generic safepoints and release

1. `Fiber.interrupt` defaults to `Result.Panic(Interrupted(frame))` and delegates to the unsafe promise/task machinery.
2. `IOTask.interrupt` atomically changes the task's ownership/status to interrupted. For a running task it calls `Safepoint.stop(thread, this)`; the task identity prevents a late signal from stopping some other slice on that worker. Idle/parked cases are handled by the task/promise state machine rather than by throwing an Abort operation into arbitrary code.
3. Kernel safepoint checks cause computation to park; `Eval.partial` returns its pending remainder. The scheduler distinguishes an interruption from ordinary preemption using its own status, then abandons rather than resumes that remainder.
4. `IOTask.abandon` invokes generic `Eval.release`, supplying `Tag[Async.Join]` and a callback to unlink an outstanding wait. Region releases/finalizers run before `settleInterrupt` makes the interrupted result available. [S4, lines 341–361; S8; S16; S17]

The kernel therefore knows how to stop cooperatively, preserve a remainder and unwind/release regions, but not the meaning of an Abort value or which scheduler task was cancelled. The JVM/Native safepoint source explicitly says it does not block or interrupt: a computation that never polls is not preempted by this mechanism. This is not a guarantee of immediate cancellation of arbitrary blocking/native code. JS/Wasm has a separate safepoint implementation; the detailed cross-thread stop description above is JVM/Native. [S17; S8]

## 6. Implications for kyoot's next decision tickets

These are recommendations inferred from the sources, not decisions that this research ticket makes for the rewrite:

1. Separate **context bindings**, **operation handlers**, and **state-isolation policies**. Do not call a blanket handler-stack copy “Kyo semantics.”
2. Make Var reconciliation a named choice (`update` / `merge` / `discard`) and specify when successful join applies it, including what happens for failed, interrupted or never-joined children.
3. Distinguish inheriting a Local service **reference** from cloning its internal state. A Local-backed Random service would address the duplicated-seed mechanism differently from an arrow effect whose handler state is copied.
4. Keep Abort interpretation and fiber cancellation policy in library/runtime layers; a generic kernel still needs an interruption hook and reliable region release.
5. Use the pinned current names in follow-up design work; do not build around absent `Async.run` or public `Isolate.Stateful` APIs.

## Verification and limits

This is source-and-documentation research, not a Scala implementation or benchmark. I inspected the pinned source, module READMEs and Local tests; I did **not** run the upstream test suite. API absences above were checked in the current source tree, not inferred from old documentation. I did not establish which historical release used the ticket's older names. I traced the JVM/Native cooperative interruption path, not every platform's blocking-I/O interruption behavior. Concurrent Random draw ordering and restoration on repeated/multiple consumers are not given a stronger contract here than the inspected implementation establishes.

## Primary sources (all pinned to the inspected main revision)

### Documentation

- [D1 — `kyo-kernel/README.md`: context handlers, continuation confinement and Isolate](https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-kernel/README.md#isolate-crossing-an-execution-boundary), especially lines 815–931.
- [D2 — `kyo-prelude/README.md`: Local and Var isolation](https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-prelude/README.md#L193-L290).
- [D3 — `kyo-core/README.md`: fibers, Clock and ambient services](https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-core/README.md), especially lines 222 onward, 697–772 and 820–886.

### Source and tests

- [S1 — `kyo-kernel/shared/src/main/scala/kyo/kernel/Isolate.scala`](https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-kernel/shared/src/main/scala/kyo/kernel/Isolate.scala).
- [S2 — `kyo-kernel/shared/src/main/scala/kyo/kernel/internal/Stack.scala`, contextual snapshot](https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-kernel/shared/src/main/scala/kyo/kernel/internal/Stack.scala#L224-L246).
- [S3 — `kyo-prelude/shared/src/main/scala/kyo/Var.scala`, isolation strategies](https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-prelude/shared/src/main/scala/kyo/Var.scala#L197-L257).
- [S4 — `kyo-core/shared/src/main/scala/kyo/Fiber.scala`](https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-core/shared/src/main/scala/kyo/Fiber.scala).
- [S5 — `kyo-combinators/shared/src/main/scala/kyo/AsyncCombinators.scala`](https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-combinators/shared/src/main/scala/kyo/AsyncCombinators.scala#L10-L51).
- [S6 — `kyo-kernel/shared/src/main/scala/kyo/kernel/ContextEffect.scala`](https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-kernel/shared/src/main/scala/kyo/kernel/ContextEffect.scala).
- [S7 — `kyo-prelude/shared/src/main/scala/kyo/Local.scala`](https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-prelude/shared/src/main/scala/kyo/Local.scala).
- [S8 — `kyo-core/shared/src/main/scala/kyo/scheduler/IOTask.scala`](https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-core/shared/src/main/scala/kyo/scheduler/IOTask.scala), boundary, interrupt, run, abandon and apply.
- [S9 — `kyo-core/shared/src/main/scala/kyo/Async.scala`](https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-core/shared/src/main/scala/kyo/Async.scala).
- [S10 — `kyo-prelude/shared/src/main/scala/kyo/Abort.scala`](https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-prelude/shared/src/main/scala/kyo/Abort.scala#L41-L72), and lines 190–237 for runWith.
- [S11 — `kyo-core/shared/src/main/scala/kyo/Clock.scala`](https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-core/shared/src/main/scala/kyo/Clock.scala), lines 185–197 and 524–557.
- [S12 — `kyo-core/shared/src/main/scala/kyo/Log.scala`](https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-core/shared/src/main/scala/kyo/Log.scala), local/let and logging dispatch.
- [S13 — `kyo-core/shared/src/main/scala/kyo/Random.scala`](https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-core/shared/src/main/scala/kyo/Random.scala#L161-L232).
- [S14 — `kyo-core/shared/src/main/scala/kyo/Sync.scala`, withLocal](https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-core/shared/src/main/scala/kyo/Sync.scala#L182-L202).
- [S15 — `kyo-prelude/shared/src/test/scala/kyo/LocalTest.scala`, inheritance tests](https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-prelude/shared/src/test/scala/kyo/LocalTest.scala#L114-L178).
- [S16 — `kyo-kernel/shared/src/main/scala/kyo/kernel/internal/Eval.scala`](https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-kernel/shared/src/main/scala/kyo/kernel/internal/Eval.scala), partial evaluation, generic dispatch and release.
- [S17 — `kyo-kernel/jvm-native/src/main/scala/kyo/kernel/internal/Safepoint.scala`](https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-kernel/jvm-native/src/main/scala/kyo/kernel/internal/Safepoint.scala), design commentary and stop.
