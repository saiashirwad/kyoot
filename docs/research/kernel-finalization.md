# Finalization and defect catching at the kernel boundary

Research for [ticket #29](https://github.com/saiashirwad/kyoot/issues/29), feeding the ensure/catch decision in [map #20](https://github.com/saiashirwad/kyoot/issues/20). Researched 2026-10-01 from first-party source code only.

## Answer

**Keep cleanup ownership and host-exception unwinding in the kernel; keep resource policy and typed failure interpretation in libraries.** Kyo is the closest match to the requested effect-agnostic kernel: its kernel owns region release, dropped-remainder cleanup, and generic recovery hooks without knowing `Abort` or `Async`. Koka shows why merely wrapping normal continuation resumption is insufficient: ordinary control clauses explicitly finalize a continuation they never resume. Effect shows a different valid architecture: finalizers are effect programs interpreted by the fiber runtime, with interruption masking and full failure causes built in. [K1–K5, O1–O3, E1–E4]

**“Interruption is uncatchable” needs qualification.** Kyo task cancellation abandons a remainder rather than throwing through its recovery clauses. Koka uses a separate `discontinue` effect, not the exception effect. Effect's defect-only catcher excludes interruption, but its full-cause catcher explicitly includes it; do not generalize defect-only safety into a claim that no API can observe/recover an interruption. [K5, O4, E5]

## Scope and reproducibility

These are pinned development snapshots, **not claims about every released version**:

- Kyo: [`20473af365ba818f161c370ef22e2f81c1f377ff`](https://github.com/getkyo/kyo/tree/20473af365ba818f161c370ef22e2f81c1f377ff).
- Koka: [`046254c139ea33ce132823599f860f5395c1de21`](https://github.com/koka-lang/koka/tree/046254c139ea33ce132823599f860f5395c1de21), current `lib/std`, not the historical `lib/v1` implementation.
- Effect: [`8b0eac6ac46a689a7208500e2ccf9e3b80fc3898`](https://github.com/Effect-TS/effect/tree/8b0eac6ac46a689a7208500e2ccf9e3b80fc3898), whose package declares **4.0.0-rc.118**. Accordingly the names below are `catchDefect`/`catchCause`, not a claim about v3 `catchAllDefect`/`catchAllCause` internals. [E0]
- Local kyoot baseline: [`421ad78f5c3f4be16ab7b629879c2ecddb78570f`](https://github.com/saiashirwad/kyoot/tree/421ad78f5c3f4be16ab7b629879c2ecddb78570f).

“Kernel” below means the machinery that evaluates, unwinds, and owns suspended computations, not simply a directory called `internal`. Findings are static source traces; no upstream builds, test suites, or benchmarks were run.

## Comparison

| Question | Kyo | Koka | Effect (v4 snapshot) |
|---|---|---|---|
| Smallest cleanup mechanism | Kernel `Bracket` built over context-handler release, plus evaluator ownership/unwind | Core `finally` prompts and final-yield protocol; protected control clauses | Runtime `OnExit` primitive and continuation stack |
| Resource layer | `Sync.ensure` / `acquireReleaseWith`, asynchronous `Scope` | `on-exit` is an alias over core `finally`; exception handling is an effect handler | `ensuring` wraps `onExit`; `acquireRelease` registers a finalizer in `Scope` |
| Never-resumed continuation | Owning region drains releases; scheduler explicitly releases abandoned parked computation | Ordinary `ctl` protects an unused resumption and sends `Finalize`; `raw ctl` opts out | No analogous user algebraic-handler resumption in this API; a never-calling async callback stays suspended until interrupted |
| Defect catch | Evaluator catches host throws; generic handler recovery hook; `Abort` classifies above kernel | `exn` is a `final ctl` effect, caught by a library handler; not an Effect-style universal host-defect channel | Run loop turns thrown JS errors into `Die`; `OnFailure` catches causes; defect catcher filters |
| Can cleanup perform effects? | Kernel release: **no** pending effects. Sync wrapper: bounded Sync/Abort. Scope: Async/Abort drain | **Yes**: `fin: () -> e ()`; finalization can itself yield | **Yes**: finalizer returns `Effect`, run masked by default |

Sources by column: Kyo [K1–K7]; Koka [O1–O4]; Effect [E1–E6]. The distinctions in the rest of this note are important to interpreting the short cells.

## 1. Kyo: generic ownership below effect-specific policy

### Cleanup is kernel-supported, not just a `flatMap` callback

`Bracket.apply(acquire)(use)(release)` creates a `Cell.Live` with an atomic exactly-once guard and installs a `Handler.ContextHandler`. That handler's `release` runs the cell; `complete` records a clean end; `fork` supplies an inert cell so an isolated child does not release the parent's bracket; `reenter` rejects using an already released resource. The callback is `(A, Maybe[Throwable]) => Unit`, deliberately not an effect-returning function. [K1]

The acquisition boundary matters: `Arrow.Ensure` installs the obligation as the acquired value arrives, without a schedulable gap. `Bracket.ensuring`, by contrast, creates a region from the start, so explicit abandonment can find its release even if the body never takes a step. This does **not** mean that merely constructing and garbage-collecting an arbitrary computation runs cleanup: the guarantee relies on the runtime/handler owning and releasing that computation. [K1]

### Dropping is an explicit lifecycle event

The evaluator tracks releases and owed remainders. At an ordinary arrow-handler exit it drains them; an escaping/first handler transfers that ownership to the enclosing scope instead. Consequently a remainder handed out as a value does not make its resource immortal: its owning scope eventually releases it, and a later re-entry fails rather than uses a dead resource. [K1, K2]

`Eval.release` explicitly walks a computation's regions **without running the remaining user computation**. It walks deferrals rather than executing them, avoiding new acquisitions after cancellation. This is the essential capability missing from an implementation that only invokes a finalizer after `resume()` returns. [K3]

### Defect catching belongs partly in the evaluator, partly above it

The evaluator's guarded loop catches thrown failures and unwinds regions. Before an arrow handler's `onRecover` decides whether to recover, the releases/remainders it held are drained with the failure. Fatal errors bypass recovery through `IsFatal`; a recovery result is itself another computation evaluated under the guard. [K2]

`ArrowEffect.handleCont` exposes the generic `Throwable => Maybe[computation]` recovery arm. `Abort.runWith` uses it to classify thrown values into `Result.Failure` or `Result.Panic`; `Abort.catching` installs a private, never-suspended `Catching` effect solely to obtain that recovery region. Thus typed abort/panic policy is **not** hardwired into kernel unwinding. [K4]

### Interruption does not travel through the canceled body's catch

`IOTask.interrupt` changes task status and stops the running slice through a safepoint. Once the slice stops, `abandon` clears the remainder, marks the task done, invokes `Eval.release`, and only then settles the interrupted result. It does not resume the body with a thrown interruption. This is why a recovery clause inside the canceled computation cannot turn that cancellation into continued execution. Observing an interrupted fiber's result outside that body is a different operation. [K5]

### Effectful finalizers are a higher layer

`Sync.ensure`/`Sync.acquireReleaseWith` build on `Bracket`, record `Abort` outcomes outside the kernel, and synchronously run finalizers limited to `Sync & Abort[Throwable]` with `Sync.Unsafe.evalOrThrow`. Their kernel callback is still synchronous. [K6]

`Scope` supports finalizers with `Async & Abort[Throwable]`. Its implementation captures context for a drain, queues finalizers, and spawns the drain on a separate fiber because a synchronous bracket release cannot suspend awaiting that work. Its completion promise is uninterruptible to prevent an interrupted waiter from interrupting the drain. **Copying Kyo's raw `Unit` release hook alone would not provide asynchronous finalization.** The pinned implementation also explicitly documents an open limitation: abnormal exit spawns this drain without waiting, so a joiner may observe an interrupted fiber's result while an asynchronous finalizer is still running. Thus completion of the kernel's synchronous release is not completion of all Scope finalizers. [K7]

## 2. Koka: final-yield semantics make abandonment observable

### Library syntax resting on core control machinery

`on-exit` delegates to `std/core/hnd.finally`. `finally-prompt` has three paths: ordinary completion runs `fin`; a non-final yield extends the continuation with the prompt; a final yield captures the pending yield, runs `fin`, and re-yields the original control transfer afterward. If the finalizer itself yields, it extends that finalizer's continuation before re-yielding. This is core control machinery, not an ordinary exception-only handler. [O1, O3]

### An ordinary handler that never resumes still finalizes

`clause-control1` wraps its clause with `protect`. The protection initially records `NeedsFinalization(k)` and changes to `NoFinalization` on resumption. If the clause returns without resuming, `protect-prompt` calls `k(Finalize(res))`; if the clause itself exits via a final yield, it finalizes before re-yielding that exit. `final ctl` uses `clause-never1`/`yield-to-final`, which avoids capturing a resumption and executes finalizers eagerly. [O2]

**Exception:** `raw ctl` directly exposes a `resume-context` without `protect`. Its caller is responsible for lifetime management; the runtime offers `resume-context.finalize`. The official Unix-handler sample explicitly uses `raw` so a resumption can outlive lexical scope instead of automatically running finalizers. Do not promise automatic finalization for arbitrary escaped raw resumptions. [O2, O5]

### Exceptions and cancellation are distinct effects

`exn` declares `final ctl throw-exn`; `try` installs a handler for that operation. Compiler-generated pattern-match errors call that same exception effect. This makes Koka's ordinary exception catching a library handler over the core final-control protocol, rather than the Kyo/Effect pattern of a blanket host-language exception catch around an evaluator. These sources do not establish that every foreign C/JS failure is translated to `exn`. [O3]

Async cancellation delivers `Cancel` to waiting operations; their abstractions call the separate `final ctl discontinue()`. The source explicitly says the purpose of using a separate effect is to avoid exception handlers catching cancellation, while still executing finalizers. This is separation from **ordinary exception catching**, not a proof that code cannot deliberately install a handler for `discontinue`: it is a public effect, and the async runtime installs such handlers. [O4]

### Finalizers really are effectful

`finally(fin: () -> e (), action: () -> e a): e a` retains the finalizer's effect row, and the implementation explicitly handles a yielding finalizer. This is stronger than calling a JavaScript generator's `.return()` once and requiring its result to be `done`. It also means finalization needs working effect-handler context and continuation bookkeeping. [O1]

## 3. Effect: effectful finalizers on a fiber unwind stack

### Primitive exit handling, derived resource combinators

`OnExit` is a runtime primitive: evaluation pushes it on the fiber stack; both success and failure continuations invoke the finalizer. Its shared continuation hook makes the fiber uninterruptible by default during finalization. `ensuring` is a thin wrapper over `onExit`. On original failure, a finalizer failure is combined with the original cause rather than silently losing it. [E1]

`acquireRelease` is derived: it gets the scope, captures the service context, masks interruption around acquisition/registration, and registers an effectful release in that scope. This snapshot optionally restores interruption for acquisition; registration still occurs within the mask. `scoped`/`scopedWith` close their scope through `onExit`. [E2]

A scope changes to `Closed` before draining. Sequential draining iterates registered finalizers in reverse order, captures each exit, and aggregates their results; a parallel strategy is also supported. A newly registered finalizer on an already closed scope runs immediately. Public scope closure enters an uninterruptible region. [E3]

### “Dropped continuation” is not the same model

The relevant analogue is a suspended fiber: `never` is an async callback that never resumes. Not calling its callback is **not** an exit, so enclosing finalizers do not run merely because time passes or a callback reference is lost. Interruption of a suspended fiber instead evaluates a failing interruption cause, driving the failure continuation stack and therefore its `OnExit` frames. A cleanup guarantee requires an owner to interrupt the fiber or close the scope; forgetting a fiber is not itself finalization. This conclusion is a source-level inference from callback suspension, the interrupt path, and the exit primitive—not a claim that Effect exposes Koka-style arbitrary algebraic continuations. [E1, E4, E6]

### Catching defects versus catching interruption

The run loop catches thrown JavaScript errors and re-enters with `exitDie(error)`. `catchCause` builds an `OnFailure` primitive; `catchDefect` is a library filter over it using `findDefect`. The public API explicitly documents that defect catching excludes typed failures and interruptions, whereas full-cause catching includes interruptions. [E4, E5]

The runtime separately retains `_interruptedCause` and rechecks it when restoring interruptibility. That is a cancellation-state/masking mechanism, not evidence that all cause handlers are forbidden from inspecting interruption. The safe conclusion for kyoot is narrow: **ordinary defect recovery must not accidentally handle cancellation; a full-cause recovery API is an additional policy decision.** [E4, E5, E7]

### Finalizers may suspend and require services

The finalizer is an `Effect`, not a synchronous destructor. `onExit` and `ensuring` include its error and environment types in the result; `acquireRelease`'s release has a `never` typed-error channel but still may have defects. `acquireRelease` captures and restores the registration environment for the release. Masking prevents ordinary interruption during cleanup; it does not guarantee a finalizer terminates. [E1, E2]

## Implications for kyoot's ensure/catch ticket (recommendations, not implemented decisions)

1. **Make continuation ownership explicit.** Normal completion, a handler answering without resumption, host throw, and runtime cancellation must all terminate owned regions. Ownership transfer must be explicit if a continuation escapes. Never depend on garbage collection to detect “nobody will resume.” Kyo's owed-release lanes and Koka's protected clauses are concrete precedents. [K1–K3, O2]
2. **Separate recovery from release.** The kernel should offer generic host-defect recovery and unconditional cleanup hooks, with cancellation using a non-recovering abandon path. Typed `Fail`/`Result` classification belongs above that boundary, as `Abort` does in Kyo. [K2–K5]
3. **Decide which cleanup contract the kernel promises.** A Kyo-like synchronous release hook is simple but insufficient by itself for arbitrary asynchronous cleanup. Either add an explicit effectful unwind program interpreted with defined context, or place an owned drain/Scope layer above the synchronous release hook. Do not label either choice “just finally.” [K6–K7, O1, E1–E3]
4. **Preserve acquisition/registration atomicity.** There must be no cancellation point after acquisition succeeds but before cleanup is owed. Kyo uses its non-polling ensure continuation; Effect uses masking. Choose an equivalent guarantee even if the implementation has neither of those exact names. [K1, E2]
5. **Specify cleanup failure and ordering explicitly.** Kyo suppresses release failures onto an existing unwind failure; Effect combines causes and attempts all scope finalizers. Which error wins, whether all cleanups still run, and LIFO versus parallel execution are policies requiring tests, not incidental consequences of JS `throw`. [K1–K3, E1, E3]

### Existing kyoot constraints worth preserving or deliberately changing

At the pinned baseline, `GeneratorFrame.close()` calls `.return(undefined)` and raises a defect if the generator yields during closure, because its handlers are already removed. The forced closer explicitly skips effectful cleanup when no machine remains. Separately, `Resource.run` keeps finalizers in a handler, drains them LIFO as effect programs, records thrown finalizer defects, and supplies `onSuccess`, `onDefect`, and `onInterrupt` hooks. Thus kyoot already has **two distinct cleanup contracts**; a rewrite should not accidentally conflate them. [L1, L2]

Suggested acceptance cases for the follow-up (design recommendations):

- normal completion, synchronous throw, and a failure after at least one suspension;
- handler returns without resuming, handler throws without resuming, and a saved continuation is used after drop;
- cancellation while suspended, cancellation after acquisition but before registration, and repeated cancellation during cleanup;
- nested finalizers with multiple failures: all attempted, documented order and winning/combined error;
- effectful cleanup that suspends and reads its required services, including cancellation of its waiter;
- defect recovery around a canceled body cannot restart it;
- unstarted `ensure` versus uncompleted `acquire`: explicitly define which obligation exists;
- generator `finally` that yields remains a clear defect unless the new evaluator deliberately supports draining it under a valid handler context.

## What is not confirmed

- Runtime execution of these traces, performance, and race freedom under all schedules; this was a source review, not a verification exercise.
- Release-history compatibility: notably Effect v3 and older Kyo `ensure`/catch implementations are outside this snapshot comparison.
- Universal translation of Koka foreign-runtime faults into `exn`, and arbitrary escaped `raw ctl` cleanup; the cited safe-clause guarantee does not establish either.
- A universal exactly-once theorem for multi-shot computations across all three systems. Kyo's bracket guard and repeated-handler ownership are explicit; Koka's protection marks a resumption as used. These are not interchangeable multi-shot resource policies.
- Whether kyoot should permit effectful generator `finally`, or adopt a separate Scope drain. This research identifies the tradeoff; the ensure/catch decision ticket should settle it.

## Primary sources

All links are immutable commit permalinks. Ranges identify the implementation or first-party API commentary supporting the claims.

[K1]: https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-kernel/shared/src/main/scala/kyo/kernel/Bracket.scala#L14-L158
[K2]: https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-kernel/shared/src/main/scala/kyo/kernel/internal/Eval.scala#L470-L595
[K3]: https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-kernel/shared/src/main/scala/kyo/kernel/internal/Eval.scala#L618-L710
[K4]: https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-prelude/shared/src/main/scala/kyo/Abort.scala#L190-L230
[K5]: https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-core/shared/src/main/scala/kyo/scheduler/IOTask.scala#L150-L379
[K6]: https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-core/shared/src/main/scala/kyo/Sync.scala#L61-L163
[K7]: https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-core/shared/src/main/scala/kyo/Scope.scala#L273-L388
[O1]: https://github.com/koka-lang/koka/blob/046254c139ea33ce132823599f860f5395c1de21/lib/std/core/hnd.kk#L481-L499
[O2]: https://github.com/koka-lang/koka/blob/046254c139ea33ce132823599f860f5395c1de21/lib/std/core/hnd.kk#L549-L672
[O3]: https://github.com/koka-lang/koka/blob/046254c139ea33ce132823599f860f5395c1de21/lib/std/core/exn.kk#L20-L84
[O4]: https://github.com/koka-lang/koka/blob/046254c139ea33ce132823599f860f5395c1de21/lib/std/async/async.kk#L20-L75
[O5]: https://github.com/koka-lang/koka/blob/046254c139ea33ce132823599f860f5395c1de21/samples/handlers/unix.kk#L167
[E0]: https://github.com/Effect-TS/effect/blob/8b0eac6ac46a689a7208500e2ccf9e3b80fc3898/packages/effect/package.json#L1-L4
[E1]: https://github.com/Effect-TS/effect/blob/8b0eac6ac46a689a7208500e2ccf9e3b80fc3898/packages/effect/src/internal/effect.ts#L4182-L4269
[E2]: https://github.com/Effect-TS/effect/blob/8b0eac6ac46a689a7208500e2ccf9e3b80fc3898/packages/effect/src/internal/effect.ts#L4135-L4179
[E3]: https://github.com/Effect-TS/effect/blob/8b0eac6ac46a689a7208500e2ccf9e3b80fc3898/packages/effect/src/internal/effect.ts#L3947-L4040
[E4]: https://github.com/Effect-TS/effect/blob/8b0eac6ac46a689a7208500e2ccf9e3b80fc3898/packages/effect/src/internal/effect.ts#L580-L715
[E5]: https://github.com/Effect-TS/effect/blob/8b0eac6ac46a689a7208500e2ccf9e3b80fc3898/packages/effect/src/Effect.ts#L3214-L3314
[E6]: https://github.com/Effect-TS/effect/blob/8b0eac6ac46a689a7208500e2ccf9e3b80fc3898/packages/effect/src/internal/effect.ts#L1223-L1232
[E7]: https://github.com/Effect-TS/effect/blob/8b0eac6ac46a689a7208500e2ccf9e3b80fc3898/packages/effect/src/internal/effect.ts#L4554-L4632
[L1]: https://github.com/saiashirwad/kyoot/blob/421ad78f5c3f4be16ab7b629879c2ecddb78570f/packages/kyoot/src/machine.ts#L18-L130
[L2]: https://github.com/saiashirwad/kyoot/blob/421ad78f5c3f4be16ab7b629879c2ecddb78570f/packages/kyoot/src/effects/resource.ts#L21-L71

- [K1]: Kyo kernel `Bracket`: ownership, exactly-once guard, atomic registration, synchronous release, re-entry check.
- [K2], [K3]: Kyo evaluator: ordinary/escaping region exits, exception recovery, and explicit abandonment walk.
- [K4]: Kyo `Abort.runWith` policy over generic recovery. Also see [`Abort.catching`](https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-prelude/shared/src/main/scala/kyo/Abort.scala#L581-L630) and [`ArrowEffect.handleCont` recovery overload](https://github.com/getkyo/kyo/blob/20473af365ba818f161c370ef22e2f81c1f377ff/kyo-kernel/shared/src/main/scala/kyo/kernel/ArrowEffect.scala#L118-L155).
- [K5], [K6], [K7]: Kyo task cancellation, synchronous wrappers, asynchronous Scope drain setup.
- [O1], [O2], [O3], [O4], [O5]: Koka core finalization and clause protection, exception effect, cancellation effect, raw-clause escape example. Async boundary handlers: [`discontinue` handler](https://github.com/koka-lang/koka/blob/046254c139ea33ce132823599f860f5395c1de21/lib/std/async/async.kk#L277-L331).
- [E0], [E1], [E2], [E3], [E4], [E5], [E6], [E7]: Effect version, exit primitive, acquisition/scope library, scope draining, fiber loop, public catch semantics, callback/never, masking. Catch implementation: [`OnFailure` and defect filtering](https://github.com/Effect-TS/effect/blob/8b0eac6ac46a689a7208500e2ccf9e3b80fc3898/packages/effect/src/internal/effect.ts#L2598-L2723).
- [L1], [L2]: kyoot generator closure and resource handler at the starting commit.
