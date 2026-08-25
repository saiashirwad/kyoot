# kyoot

Algebraic effects for TypeScript. A program is a value that lists the effects it uses in its type. You handle them one at a time with `pipe`, and you can only run the program once the list is empty.

```ts
import { Env, Fail, Kyoot, Sync } from "kyoot";

const Db = Env.tag<{ find(id: string): string | undefined }>()("db");

class NotFound {
  readonly _tag = "NotFound";
}

const lookup = (id: string) =>
  Kyoot.gen(function* () {
    const db = yield* Db;
    const name = yield* Sync.defer(() => db.find(id));
    if (name === undefined) return yield* Fail.fail(new NotFound());
    return name;
  });
// Kyoot<string, { "env/db": { find: ... }; fail: NotFound; sync: () => unknown }>

const result = lookup("42").pipe(
  Db.provide({ find: (id) => (id === "42" ? "douglas" : undefined) }),
  Fail.run,
  Sync.run,
  Kyoot.runSync,
);
// Result<NotFound, string>, here { ok: true, value: "douglas" }
```

The second type parameter is the row: one key per effect the program still needs handled. `runSync` and `runPromise` reject a program with keys left, and the error names them:

```ts
Kyoot.runSync(lookup("42"));
// Type error: Unhandled<"env/db" | "fail" | "sync">
```

## How it works

An effect is a key, a payload type, and an answer type. Calling it performs an op.

```ts
const Log = effect<string, void>()("log");
Log("hello");
// Kyoot<void, { log: string }>
```

A handler catches one key and resumes the program, optionally with new state. `resume` is typed to the answer.

```ts
const printLogs = Log.handle({
  onOp: (line, resume) => Sync.defer(() => console.log(line)).map(resume),
});
// <A, S>(k: Kyoot<A, S>) => Kyoot<A, Omit<S, "log"> & { sync: () => unknown }>
```

A handler that only wants to sit between the program and the handlers outside it uses `intercept`. It sees the payload and a `next` that performs the op again for the outer handlers to answer. Whatever it returns — a value, or a failure — is delivered where the op was performed, so the program can catch it. This is how a cache, a sandbox, or a system prompt is written.

```ts
const cache = Fetch.intercept((url, next) => (url === "hot" ? Kyoot.succeed("cached") : next(url)));
program.pipe(cache, live);
```

A handler that also reshapes the final value uses `makeHandler` directly; `onSuccess` sees the value and the final state. This is how `Clock.virtual` is written:

```ts
const virtual = <A, S extends Row & { clock?: number }>(k: Kyoot<A, S>) =>
  makeHandler("clock", k, {
    initial: 0,
    onOp: (ms, resume, now) => resume(undefined, now + ms),
    onSuccess: (a, now) => Kyoot.succeed([a, now] as const),
  });
// Kyoot<readonly [A, number], Omit<S, "clock">>
```

The row is a plain object type with the payload type as each key's value. `yield*` unions rows, a handler removes its key, and `RowsOf<typeof program>` reads it back.

State is `initial`, threaded through `resume`, or `create()`, called when the handler's frame is entered — a mutable cell that is fresh per run and shared with fibers forked under the handler. `Log.collect` and `Emit.run` use `create`, so a fiber's entries land in the parent's list.

A handler also says what it does at a fork, with `fork`. `"copy"` (the default): the fiber gets `onOp` with the frame's state as it stands — a cell from `create` is shared, threaded state is a snapshot (a `Var` set in a fiber is not seen after `join`) — and the frame's end hooks stay with the parent. `"scope"`: the fiber gets a frame of its own, with `onSuccess` run at the fiber's end; `Resource.run` does this, so a fiber has a scope of its own. `"none"`: the handler stops at the fiber, and an op for it inside the fiber is unhandled. `fail` handlers never cross into a fiber, whatever their mode: a fiber's failure crosses `join` and meets the handlers there.

## Built-in effects

| Module     | Op                                                                      | Handlers                                                                         |
| ---------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `Fail`     | `fail(e)`                                                               | `run` (to `Result`), `catchAll(f)`, `catchTag(tag, f)`, `mapError(f)`, `orThrow` |
| `Env`      | `tag<T>()("id").get()`                                                  | `tag.provide(impl)`                                                              |
| `Var`      | `tag.get()`, `tag.set(v)`, `tag.update(f)`                              | `tag.run(initial)` (to `[A, V]`)                                                 |
| `Log`      | `info(msg)`, `warn`, `error`, `debug`                                   | `print`, `collect` (to `[A, Entry[]]`), `discard`                                |
| `Random`   | `next()`, `int(max)`                                                    | `live`, `seeded(seed)`                                                           |
| `Emit`     | `value(e)`, `fromIterable(xs)`, `fromAsyncIterable(xs)`                 | `run` (to `[A, E[]]`), `forEach(f)`, `map(f)`, `discard`, `toAsyncIterable`      |
| `Sync`     | `defer(() => x)`                                                        | `run`                                                                            |
| `Resource` | `acquire(open, close)`                                                  | `run`                                                                            |
| `Clock`    | `sleep(ms)`                                                             | `virtual` (to `[A, elapsedMs]`), `runPromise`                                    |
| `Retry`    |                                                                         | `run({ times, delay })`                                                          |
| `Async`    | `fromPromise(f)`, `fork`, `race`, `all(ks, { concurrency })`, `timeout` | `runPromise`                                                                     |

Tags are keyed by id, so `Env.tag<A>()("a")` and `Env.tag<B>()("b")` are separate keys and one program can use both. `Var` threads state through its handler; `Env` hands out a constant.

`Resource.run` releases in reverse order on success, defect, or interrupt. A failure in a finalizer never hides the original error.

A stream is a program that emits. `Emit.fromAsyncIterable` turns an async source into one, `Emit.map` and `Emit.forEach` transform and consume it (a `forEach` callback may return a program, whose effects join the row), and `Emit.toAsyncIterable` runs it and hands the values out as they arrive. The producer runs at most `buffer` values ahead (16 by default; `{ buffer: 1 }` is pull) and parks until the consumer takes one; breaking out of the loop interrupts it.

`Resource.acquire`'s `close` may return a program, so a finalizer can do async work. Finalizers run to completion on success, defect, and interrupt; after an interrupt is delivered, the ops a fiber performs are treated as cleanup and are not interrupted again.

`Clock.sleep` is served by `runPromise` with real timers unless a handler is closer; `Clock.virtual` makes every sleep instant and reports the elapsed time, so a program that waits can run under `runSync` in tests. `Retry.run` re-runs a program on a typed failure, sleeping between attempts (`delay` is a number or `(attempt) => ms`); defects are not retried, and the last failure stays in the row.

## Async

`runPromise` serves the `async` and `clock` keys itself and knows nothing about any other effect.

```ts
const main = Kyoot.gen(function* () {
  const fast = yield* Async.race(fetchUser("a"), fetchUser("b"));
  const fiber = yield* Async.fork(slowJob);
  const result = yield* Async.timeout(5000, fiber.join).pipe(Fail.run);
  return [fast, result];
});

await Kyoot.runPromise(main);
```

`fork` returns a fiber with `join`, `await` (as a `Result`), and `interrupt`. A fiber inherits the handlers around the fork, so the forked program's row is pushed onto the parent's: fork a program that needs `env/db` and the parent needs `env/db`, and the `provide` outside the fork answers inside it. What the fiber leaves out is `async` and `clock`, which its driver serves, and `fail`, which crosses `join` as a typed failure (`Fiber<A, E>`; `await` reports it as a `Fail` cause). `race`, `all`, and `timeout` work the same way and merge their branches' rows. Interrupting a fiber interrupts its children and runs their finalizers.

```ts
const main = Kyoot.gen(function* () {
  const fiber = yield* Async.fork(lookup("42")); // needs env/db, may fail with NotFound
  return yield* fiber.join; // fail: NotFound, here
}).pipe(Db.provide(db), Fail.run, Sync.run);
```

`fromPromise` passes an `AbortSignal` to your function. Give it to `fetch` and interrupting the fiber cancels the request.

A fiber yields to the event loop every few thousand steps, so a hot loop of ops in one fiber neither starves the rest nor blocks its own interrupt. A loop inside a single `Sync.defer` is one step and cannot be preempted. `runSync` never yields.

## Your own effect

Declare one `effect` and one handler per interpretation. `examples/checkout.ts` does this for a business program: `Inventory` and `Payments` are effects, and the handlers are an in-memory stock table and a test double. A handler may fail instead of resuming, which adds `fail` to the row at that step: the failure belongs to the handler's scope, and the program inside cannot catch it.

```ts
const Payments = effect<Charge, string>()("payments");
const declineAll = (reason: string) =>
  Payments.handle({ onOp: () => Fail.fail(new PaymentDeclined(reason)) });
```

When the failure is part of the effect's contract, declare it as the third type argument and hand it back with `resume.with`. It is then raised where the op was performed, so the program's own `catchTag` sees it. This is how `FileSystem.readFile` fails with `NotFound`.

```ts
const Payments = effect<Charge, string, PaymentDeclined>()("payments");
const declineAll = (reason: string) =>
  Payments.handle({ onOp: (_, resume) => resume.with(Fail.fail(new PaymentDeclined(reason))) });
```

`op<A>()(key, payload)` is the one-off form underneath `effect`, for ops whose payload type varies per call (`Fail.fail`, `Emit.value`).

## An agent

`examples/agent.ts` shows the shape for an AI library: the model call is an effect, tools are effects, providers and test doubles are handlers. A provider handler may itself retry, stream tokens with `Emit`, log, and fail with a typed error, and every one of those shows up in the row at the step that introduces it.

```ts
const Model = effect<Prompt, string>()("model");
const Search = effect<{ query: string }, string[]>()("search");

const agent = (question: string) =>
  Kyoot.gen(function* () {
    const query = yield* Model({ messages: [`search query for: ${question}`] });
    const results = yield* Search({ query });
    return yield* Model({ messages: [question, ...results] });
  });

agent("why is the sky blue?").pipe(
  Model.handle({ onOp: (prompt, resume) => complete(prompt).pipe(Retry.run(policy)).map(resume) }),
  Search.handle({ onOp: ({ query }, resume) => resume(search(query)) }),
  Emit.forEach((token: string) => process.stdout.write(token)),
  Log.print,
  Fail.run,
);
```

## Rules

- `resume` works once; a second call throws. `resume(value)` continues the program with a value; `resume.with(program)` continues it with a computation, run where the op was.
- A thrown exception is a defect: it skips `onOp` and goes to the nearest `onDefect`, or out of `runSync`. Use `Fail` for errors you expect.
- A handler that does not resume drops the rest of the program, so handlers inside it never finish. Put `Fail.run` inside `Resource.run`; the other order leaves resources open on failure.
- A handler that returns a value instead of resuming must not be copied into a fiber, since the fiber's value is its own; mark it `fork: "none"`. A copy that short-circuits is caught and reported as a defect.

## Name

After [Kyo](https://getkyo.io), the Scala library whose effect model this follows.

## License

MIT
