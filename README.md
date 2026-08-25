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
const Clock = effect<number, void>()("clock");
Clock(1000);
// Kyoot<void, { clock: number }>
```

A handler catches one key and resumes the program, optionally with new state. `resume` is typed to the answer.

```ts
const liveClock = Clock.handle({
  onOp: (ms, resume) => Async.sleep(ms).map(() => resume(undefined)),
});
// <A, S>(k: Kyoot<A, S>) => Kyoot<A, Omit<S, "clock"> & { async: AsyncOp }>
```

A handler that also reshapes the final value uses `makeHandler` directly; `onSuccess` sees the value and the final state.

```ts
const testClock = <A, S extends Row & { clock?: number }>(k: Kyoot<A, S>) =>
  makeHandler({
    effectKey: Clock.key,
    self: k,
    state: 0,
    onOp: (ms, resume, now) => resume(undefined, now + ms),
    onSuccess: (a, now) => Kyoot.succeed([a, now] as const),
  });
// Kyoot<readonly [A, number], Omit<S, "clock">>
```

The row is a plain object type with the payload type as each key's value. `yield*` unions rows, a handler removes its key, and `RowsOf<typeof program>` reads it back.

## Built-in effects

| Module     | Op                                                              | Handlers                                       |
| ---------- | --------------------------------------------------------------- | ---------------------------------------------- |
| `Fail`     | `fail(e)`                                                       | `run` (to `Result`), `catchAll(f)`, `orThrow`  |
| `Env`      | `tag<T>()("id").get()`                                          | `tag.provide(impl)`                            |
| `Var`      | `tag.get()`, `tag.set(v)`, `tag.update(f)`                      | `tag.run(initial)` (to `[A, V]`)               |
| `Emit`     | `value(e)`                                                      | `run` (to `[A, E[]]`), `forEach(f)`, `discard` |
| `Sync`     | `defer(() => x)`                                                | `run`                                          |
| `Resource` | `acquire(open, close)`                                          | `run`                                          |
| `Async`    | `fromPromise(f)`, `sleep(ms)`, `fork`, `race`, `all`, `timeout` | `runPromise`                                   |

Tags are keyed by id, so `Env.tag<A>()("a")` and `Env.tag<B>()("b")` are separate keys and one program can use both. `Var` threads state through its handler; `Env` hands out a constant.

`Resource.run` releases in reverse order on success, defect, or interrupt. A failure in a finalizer never hides the original error.

## Async

`runPromise` handles the `async` key itself and knows nothing about any other effect.

```ts
const main = Kyoot.gen(function* () {
  const fast = yield* Async.race(fetchUser("a"), fetchUser("b"));
  const fiber = yield* Async.fork(slowJob);
  const result = yield* Async.timeout(5000, fiber.join).pipe(Fail.run);
  return [fast, result];
});

await Kyoot.runPromise(main);
```

`fork` returns a fiber with `join`, `await` (as a `Result`), and `interrupt`. Handle a program down to `async` before you fork it; a fiber runs its own interpreter, so outer handlers cannot see into it. Interrupting a fiber interrupts its children and runs their finalizers.

`fromPromise` passes an `AbortSignal` to your function. Give it to `fetch` and interrupting the fiber cancels the request.

There is no scheduler beyond the event loop. Fibers yield only at await points, so a hot loop in one fiber starves the rest.

## Your own effect

Declare one `effect` and one handler per interpretation. The clock above is one; `examples/clock.ts` runs the same program against a virtual clock in `runSync` and a real one in `runPromise`.

```ts
Kyoot.runSync(boilEgg.pipe(testClock)); // [result, virtualMs]
await Kyoot.runPromise(boilEgg.pipe(liveClock)); // result, after real sleep
```

`examples/checkout.ts` does the same for a business program: `Inventory` and `Payments` are effects, and the handlers are an in-memory stock table and a test double. A handler may also fail instead of resuming, which adds `fail` to the row at that step.

```ts
const Payments = effect<Charge, string>()("payments");
const declineAll = (reason: string) =>
  Payments.handle({ onOp: () => Fail.fail(new PaymentDeclined(reason)) });
```

`op<A>()(key, payload)` is the one-off form underneath `effect`, for ops whose payload type varies per call (`Fail.fail`, `Emit.value`).

## Rules

- `resume` works once; a second call throws.
- A thrown exception is a defect: it skips `onOp` and goes to the nearest `onDefect`, or out of `runSync`. Use `Fail` for errors you expect.
- A handler that does not resume drops the rest of the program, so handlers inside it never finish. Put `Fail.run` inside `Resource.run`; the other order leaves resources open on failure.

## Name

After [Kyo](https://getkyo.io), the Scala library whose effect model this follows.

## License

MIT
