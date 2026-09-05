# Getting started

Install `kyoot` and use Node 24+ with TypeScript 7.0.2. Import application APIs from `kyoot`; its package entry includes declarations.

## Construction and execution

`Kyoot.succeed(value)` holds a value. `Kyoot.gen(function* () { ... })` creates a lazy program; its generator starts when a runner reaches it. `Kyoot.defer(() => program)` delays constructing another program until execution. Ordinary JavaScript arguments still evaluate immediately, so `Kyoot.succeed(sendEmail())` calls `sendEmail` during construction.

`map` transforms a value. A program or Promise returned from `map` remains a value. Use `flatMap` or `yield*` to sequence programs, and `Async.fromPromise` to execute Promise work. Its callback receives an `AbortSignal`; pass it to the underlying API. Rejections are defects. `Async.tryPromise` maps rejected promises to typed failures.

```ts
import { Kyoot, Log } from "kyoot";

const program = Kyoot.succeed(21)
  .map((n) => n * 2)
  .flatMap((n) => Log.info(String(n)).map(() => n));
const result = program.pipe(Log.discard, Kyoot.runSync); // 42
```

## Rows and handler order

`Kyoot<A, S>` describes a result `A` and a row `S`: a plain object mapping operation keys to payloads. Rows track declared Kyoot operations, not arbitrary JavaScript side effects. A call to `console.log` inside a callback does not gain a `log` row on its own.

An effect also carries a hidden signature that checks its payload, answer, and contract when a handler meets it. Keep inferred program types where possible. Explicit compatibility annotations and assertions can discard type evidence; the runtime cannot distinguish two declarations that reuse the same string key.

The closest matching handler answers an operation. In `program.pipe(first, second)`, `first` sits inside `second`: operations introduced by `first` can reach `second`. A handler removes its key and adds any operations it uses. Union rows retain every possible unhandled key. `runSync` needs an empty row; `runPromise` and the checked public `runFiber` also serve `async` and `clock`.

## Services

An `Env` service is an ordinary value, and its maker is an ordinary program. `tag.provide(value)` and `tag.provideValue(value)` provide the value unchanged, even when it is itself a Kyoot program. `tag.provideEffect(maker)` executes the maker once per run at that handler's position. Put handlers for the maker's dependencies farther out in the pipe. A resource-owning maker needs an outer `Resource.run`.

`Var` tags offer `get`, `set`, and `update`. Their interceptor takes a partial table, such as `Count.intercept({ get: (op, next) => next(op).map((n) => n + 1) })`. A get callback returns the value type; set and update callbacks return void. Omitted entries pass through, so the variable still needs a handler.

## Failures, defects, and interruption

Use `Fail.fail(error)` for an expected failure. `Fail.catchAll` or `Fail.catchTag` can recover; `Fail.run` returns a `Result` with a success value or a `Cause`. A thrown exception is a defect. `Fail.orThrow` converts an unhandled failure into an exception at the runner boundary.

`Async.fork` returns a fiber. `fiber.interrupt` requests cancellation; `fiber.await` waits for shutdown and returns its `Result`. `fiber.join` returns its value or raises its failure. Cancellation is cooperative: an `AbortSignal` cannot force arbitrary JavaScript to stop.

`Async.race` lets the first completion win, including a failure. It cancels the loser and waits for loser cleanup before returning. `Async.all` preserves tuple positions and accepts a positive integer concurrency limit. `Async.timeout` uses a finite, non-negative delay, as does `Clock.sleep`.

## Resources and streams

`Resource.acquire(open, close)` owns synchronous acquisition. Use `Resource.acquireEffect` for program-based acquisition and `Resource.acquirePromise` for Promise-based acquisition. Releases may return programs or Promises; cleanup awaits them, and the required operations remain in the row. Add `Resource.run` around the whole lifetime.

Acquisition and finalizer registration complete before cancellation proceeds, so a late acquired value still gets released. This can delay cancellation if acquisition never finishes. `Resource.intercept<R>()` checks the acquired type `R`; supply its cleanup row as a second type argument when needed.

On scope exit, children stop and finish cleanup before parent finalizers run in reverse acquisition order. Finalizers run under an interrupt mask and all get a chance to run. There is no cleanup deadline: an endless finalizer or an uncooperative child can hold shutdown open.

If cleanup alone fails, the runner reports `CleanupError`. With an existing failure, defect, or interruption, cleanup failures attach to that cause as `Cause.cleanup`; an `InterruptedError` exposes `cleanup` too. Inspect those entries to see every cleanup failure without losing the original cause.

A generator's synchronous `finally` code runs when the generator closes. Yielding from `finally` during closing is a defect. Put effectful cleanup in `Resource`.

`Emit.forEach` awaits Promise callbacks and executes program callbacks. `Emit.toAsyncIterable` uses a bounded queue; early return cancels and awaits its producer. `Emit.fromAsyncIterable` owns the source iterator and awaits `return()` on early closure.

`Clock.virtual` is a sleep accumulator: it makes sleeps instant and reports their sum for that handler's state. It is not a concurrent scheduler or a simulation of wall-clock time.

`Retry.run({ retries, delay, while })` retries typed failures. `retries` counts attempts after the first; `times` is a compatibility alias. Counts must be non-negative integers and delays finite and non-negative. The predicate accepts the program's failure type. Defects do not retry. `Random.int(max)` requires a positive safe integer and returns an integer below `max`.
