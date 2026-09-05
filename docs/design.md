# Design and trusted boundaries

An operation has a key, payload, answer, and contract. Public rows remain payload maps. Hidden signatures preserve the other parts for checked handlers; they do not turn JavaScript into a pure language or make casts safe.

## Continuations

Each operation owns a one-shot continuation. Calling `resume(value)` claims it and creates a token; executing that token continues the suspended program. `resume.with(program)` executes the supplied program at the operation site, within the operation's declared contract. This is how a filesystem handler returns `FsError` to a catch around `readFile`.

Returning `Fail.fail(error)` directly from a handler fails at the handler's position. Inner application catches cannot see that failure. Use `resume.with` when failure belongs to the operation's contract.

Claiming, executing, and dropping are distinct states. A continuation cannot be claimed twice, replayed, or used for another operation. When a handler abandons a continuation, including a claimed token it never executes, the interpreter closes the suspended generators and scopes. A generator's synchronous `finally` runs during closing. A yield there is a defect, because the suspended continuation is being discarded; effectful cleanup belongs in `Resource`.

## Fork inheritance and state

A fork inherits the surrounding handlers. With the default `fork: "copy"`, it gets the current threaded state as a snapshot. A mutable cell created with `create` stays shared, so collectors can include child events; immutable state threaded through `resume` can diverge between parent and child. Copying a reference does not clone its object.

`fork: "scope"` gives the child its own handler scope and exit handling; resources use this mode. `fork: "none"` prevents inheritance. A handler that short-circuits with its own result must use `"none"`; a copied handler may not replace the child's result. Failure handlers do not cross the fork boundary. A child's typed failure reaches the parent through `join`.

## Scope exit and causes

Scope ownership is internal. Closing a scope first requests child cancellation, waits for child shutdown, then runs parent finalizers in LIFO order. Every finalizer runs under an interrupt mask, including later finalizers after an earlier cleanup failure. Runners also unwind resources on unhandled operations.

Cleanup preserves the primary cause. `Cause.cleanup` stores additional typed failures, defects, or interruptions from cleanup. `InterruptedError.cleanup` carries the same kind of entries at a thrown interruption boundary. `CleanupError.failures` reports cleanup-only failures; its `primary`, when present, preserves the prior cause. A `Result` created by `Fail.run` keeps attached cleanup failures when resources close outside it.

Cancellation requests do not force promises, callbacks, or operating-system processes to finish. Resource cleanup has no deadline. A process that ignores SIGTERM or a release that never resolves can prevent shutdown from completing.

## Public and internal APIs

Use `effect`, its `handle` and `intercept`, and the built-in effect APIs in applications. The public `runFiber` checks outstanding rows just like the other runners. The low-level `op` form supports operations whose payload depends on the call; it places more responsibility on the caller to keep a key's meaning consistent.

`kyoot/internal` exports trusted machinery for satellite implementations: `makeHandler`, `makeIntercept`, `inherit`, `Snapshot`, and `unsafeRunFiber`. These APIs can bypass proofs that a family API or registry establishes elsewhere. They are deliberately absent from the normal barrel. The package does not expose arbitrary `dist` subpaths.

TypeScript annotations using two `Kyoot` arguments remain a compatibility form. Preserve the inferred hidden signature when defining new effect APIs and forwarding programs; do not erase it with broad annotations to make an unsafe handler compile.

The hidden signature defaults to `unknown`. Composition keeps known signatures from either side, even when the other side uses a two-argument compatibility annotation. An explicit annotation on the operation itself can still discard its signature; TypeScript cannot recover that discarded information. Such annotations and assertions remain a limit of static checking.
