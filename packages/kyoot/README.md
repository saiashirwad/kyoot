# kyoot

A small, open effect system for building programs whose operations can be interpreted, intercepted, tested, and composed independently of their implementation.

Requires Node 24+ and TypeScript 7.0.2. Install with `pnpm add kyoot`. Packages ship ESM, declarations, and source maps.

Read [Getting started](../../docs/getting-started.md) for construction, execution, rows, services, failures, resources, and streams. [Design](../../docs/design.md) explains continuation ownership, fork inheritance, cleanup causes, and trusted APIs.

## A complete effect

```ts
import { effect, Kyoot } from "kyoot";

const Greeting = effect<string, string>()("greeting");
const welcome = Greeting("Ada").map((text) => `${text}!`);
const local = Greeting.handle({
  onOp: (name, resume) => resume(`Hello, ${name}`),
});
const uppercase = Greeting.intercept((name, next) => next(name).map((text) => text.toUpperCase()));

const text = welcome.pipe(uppercase, local, Kyoot.runSync); // HELLO, ADA!
```

The [domain example](examples/domain.ts) adds a live HTTP handler. Both implementations interpret the same program. Rows are plain payload maps and track declared Kyoot operations, not arbitrary JavaScript side effects.

Use `map` for values and `flatMap` for programs. A program or Promise returned from `map` stays a value. `Kyoot.defer` delays program construction. `Async.fromPromise` executes Promise work; `Async.tryPromise` maps rejections to typed failures.

## Main APIs

| Module     | Purpose                                                                         |
| ---------- | ------------------------------------------------------------------------------- |
| `Kyoot`    | `succeed`, `gen`, `defer`, checked `runSync` and `runPromise`                   |
| `Fail`     | `fail`, `run`, `catchAll`, `catchTag`, `mapError`, `orThrow`                    |
| `Env`      | Tags with value-only `provide` / `provideValue`, and `provideEffect` for makers |
| `Resource` | `acquire`, `acquireEffect`, `acquirePromise`, and `run`                         |
| `Async`    | Promise work, `fork`, `all`, `race`, and `timeout`                              |
| `Emit`     | Emit, collect, transform, await callbacks, and bridge async iterators           |
| `Var`      | Tagged state with `get`, `set`, `update`, `run`, and `intercept`                |
| `Log`      | Declared logging with print, collect, and discard handlers                      |
| `Clock`    | Sleep; `virtual` accumulates sleeps and is not a concurrent scheduler           |
| `Random`   | Random values with live and seeded handlers                                     |
| `Retry`    | Retry typed failures with `retries`, `delay`, and a typed `while` predicate     |
| `Sync`     | Defer synchronous work as an explicit operation                                 |

Use `effect` and its checked `handle` and `intercept` in application code. An operation contract declares which effects `resume.with` may return to its call site. The named public `runFiber` export checks unhandled rows. Trusted machinery such as `makeHandler`, `Snapshot`, and `unsafeRunFiber` lives in `kyoot/internal`.

## Ownership

Continuations work once. Dropping one, even after claiming a resume token, closes the suspended program. Generator `finally` runs synchronous code during closing; yielding there is a defect. Use resources for effectful cleanup.

Scopes stop and await children before running parent finalizers in reverse order. Releases and Promise-returning `Emit.forEach` callbacks are awaited. Every finalizer gets a turn under an interrupt mask. Cleanup failures attach to `Cause.cleanup` or `InterruptedError.cleanup`; cleanup-only failure raises `CleanupError`.

A fiber's `interrupt` requests cancellation; `await` waits for shutdown. A failure can win `Async.race`, and race waits for loser cleanup. Cleanup has no deadline, and cancellation cannot force uncooperative JavaScript to finish.

Run the compiled deterministic examples with `pnpm examples` from the workspace root. Network, process-exit, and live-provider examples remain opt-in.

MIT. Inspired by [Kyo](https://getkyo.io).
