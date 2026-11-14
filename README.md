# kyoot

Typed algebraic effects for TypeScript.

A program's type lists the effects it still needs. Handlers are plain functions; each one answers an effect and removes it from the type. When nothing is left, the program can run: synchronously, on promises, one step at a time from a host, or on a seeded scheduler that searches for races.

- [Example](#example)
- [Effects and handlers](#effects-and-handlers)
- [Running a program](#running-a-program)
- [Driving a program from a host](#driving-a-program-from-a-host)
- [Built-in effects](#built-in-effects)
- [Concurrency](#concurrency)
- [Simulation](#simulation)
- [Packages](#packages)
- [Naming](#naming)
- [Development](#development)

## Example

```ts
import { effect, Kyoot } from "kyoot";

const Ask = effect<string, string>()("ask");

const program = Kyoot.gen(function* () {
  const name = yield* Ask("name?");
  return `hello ${name}`;
}); // Kyoot<string, { ask: Op<string, string> }>

const handled = program.pipe(Ask.handle((_question, resume) => resume("ada")));
Kyoot.runSync(handled); // "hello ada"
```

## Effects and handlers

`effect<P, A>()(key)` declares an effect with payload `P` and answer `A`. Performing it adds `key` to the program's type.

```ts
import { effect, Kyoot } from "kyoot";
import * as Fail from "kyoot/fail";
import * as Log from "kyoot/log";

const FindUser = effect<string, { name: string } | undefined>()("db/user");

const greet = (id: string) =>
  Kyoot.gen(function* () {
    const user = yield* FindUser(id);
    if (!user) return yield* Fail.fail(`no user ${id}`);
    yield* Log.info(`greeting ${user.name}`);
    return `hello ${user.name}`;
  }); // needs "db/user", "fail" and "log"

const users = new Map([["1", { name: "ada" }]]);

greet("1").pipe(
  FindUser.handle((id, resume) => resume(users.get(id))),
  Log.print,
  Fail.run,
  Kyoot.runSync,
); // { ok: true, value: "hello ada" }
```

Running `greet` with any of those handlers missing is a type error. In tests, swap `Log.print` for `Log.collect` and the map for a fixture.

Each declared effect has:

| Method               | Use                                                                            |
| -------------------- | ------------------------------------------------------------------------------ |
| `X.handle(f)`        | Answer the effect. `f` gets the payload and `resume`, and may perform effects. |
| `X.handleWith(make)` | Same, with state created fresh for each run.                                   |
| `X.intercept(f)`     | Observe, rewrite or deny the effect, then pass it on with `next`.              |

## Running a program

- `Kyoot.runSync(program)` runs a program with no effects left.
- `runPromise(program)` from `kyoot/async` runs one that also does async work.
- `Kyoot.step(program)` hands each effect to the caller. See below.

## Driving a program from a host

`Kyoot.step` pauses at each effect the program still needs. The host reads `key` and `payload` and answers with `resume`. The program does no IO itself, so the host decides how each request is answered: from a UI, a server, a queue, or a test script.

Here an AI agent with one tool is driven by a host that owns the model call, the user's approval and the weather lookup:

```ts
const Forecast = effect<{ city: string }, string>()("forecast");
const forecast = needsApproval(
  Tool("forecast", "Weather for a city", z.object({ city: z.string() }), Forecast),
);

const agent = AI.ask("Do I need an umbrella in Pune?", { tools: [forecast] }).pipe(
  Emit.discard,
  Fail.orThrow,
);

let step = Kyoot.step(agent);
while (!step.done) {
  switch (step.key) {
    case "ai/model":
      step = step.resume(await callModel(step.payload));
      break;
    case "ai/approve":
      step = step.resume(await askUser(step.payload));
      break;
    case "forecast":
      step = step.resume(await weather(step.payload.city));
      break;
  }
}
step.value; // "Yes, it will rain."
```

`step.key` is one of the effects in the program's type, and checking it narrows `payload` and what `resume` accepts. A test can drive the same loop with scripted answers and record every request ([`host.ts`](packages/ai/examples/host.ts)).

- The same loop runs a state machine written as plain code: the program waits on a `recv` effect, and each `resume(event)` advances it ([`step.ts`](packages/kyoot/examples/step.ts)).
- `cancel()` unwinds the program, running `finally` blocks and releasing resources. A step also cleans up when declared with `using`.
- Each step can be resumed once.
- A paused step lives in memory. It doesn't survive a process restart.

## Built-in effects

| Import           | Provides                                                      | Handlers                                    |
| ---------------- | ------------------------------------------------------------- | ------------------------------------------- |
| `kyoot/fail`     | `fail`, `catchAll`, `catchTag`, `mapError`                    | `run`, `orThrow`                            |
| `kyoot/emit`     | `value`, a stream of values out of a program                  | `collect`, `forEach`, `discard`             |
| `kyoot/env`      | `tag`, typed dependencies                                     | `provide`                                   |
| `kyoot/var`      | `tag`, local state with `get`, `set`, `update`                | `run(initial)`                              |
| `kyoot/log`      | `debug`, `info`, `warn`, `error`                              | `print`, `collect`, `discard`               |
| `kyoot/random`   | `next`, `int`                                                 | `live`, `seeded(seed)`                      |
| `kyoot/resource` | `acquire(open, close)`, released in reverse order on any exit | `run`                                       |
| `kyoot/async`    | `Async`, `Clock`, `Retry`                                     | `runPromise`, `Clock.live`, `Clock.virtual` |
| `kyoot/sim`      | The `Async` effects, on a seeded scheduler                    | `Sim.run`, `Sim.explore`                    |

## Concurrency

`Async.fork`, `join`, `all`, `race`, `timeout` and `sleep` are effects. `runPromise` answers them with real fibers and timers.

```ts
const both = Async.all([buyTicket("alice"), buyTicket("bob")]);
await runPromise(both.pipe(Async.provide(liveDb)));
```

Handlers don't cross a fork. `Async.provide(handler)` installs one in every fiber.

## Simulation

`kyoot/sim` runs the same program on a seeded scheduler with virtual time. Your own effects are answered by a fake `world`, and `check` is an invariant over the result.

```ts
const found = Sim.explore(both, { seeds: 1000, world, check: noOversell });
```

`explore` runs schedules until one breaks the invariant, then shrinks it. For [`examples/sim/tickets.ts`](packages/kyoot/examples/sim/tickets.ts), where two fans buy the last ticket:

```text
main   fork alice
       fork bob
       join alice
alice  db/get "tickets" → 1
bob    db/get "tickets" → 1
       payments/charge {"fan":"bob","cents":9900}
       db/set {"key":"tickets","value":0}
       done: ok
alice  payments/charge {"fan":"alice","cents":9900}
       db/set {"key":"tickets","value":0}
       done: ok
main   join bob
       done: ok ["alice: got a ticket","bob: got a ticket"]
```

`Sim.run(program, { strategy: Sim.replay(choices) })` replays a schedule exactly.

- The clock moves only when every fiber is waiting, so hours of timeouts and backoff run in milliseconds.
- During a run, `Date.now`, `performance.now`, `Math.random`, timers, `fetch` and `crypto` randomness throw. Pass `{ guard: false }` to allow them. Module-level code is not covered.
- A world responder can return `Sim.fail(error)` to fail with the program's typed error.

## Packages

| Package                                | Contents                                                          |
| -------------------------------------- | ----------------------------------------------------------------- |
| [`kyoot`](packages/kyoot)              | Core, built-in effects, `kyoot/async`, `kyoot/sim`                |
| [`@kyoot/ai`](packages/ai)             | Models, tools and providers as effects                            |
| [`@kyoot/platform`](packages/platform) | File system and process effects, with Node and in-memory handlers |

## Naming

- `X.run` is an effect's default handler (`Fail.run`, `Var.run`, `Resource.run`).
- Other handlers are named by behaviour, the same way across effects: `live`, `virtual`, `manual`, `seeded`, `print`, `forEach(f)`, `collect`, `discard`. `provide` supplies a service.
- Functions that aren't handlers aren't named like them (`Retry.retry`).
- Each operation has its own key. `Var` has `var/<id>/get`, `var/<id>/set` and `var/<id>/update`, so you can intercept only sets.

## Development

Requires Node 22.18+, which runs TypeScript directly.

```sh
pnpm install
node packages/kyoot/examples/sim/tickets.ts
pnpm check   # format, lint, typecheck, test
```

Examples live in [`packages/kyoot/examples`](packages/kyoot/examples), [`packages/ai/examples`](packages/ai/examples) and [`packages/platform/examples`](packages/platform/examples).

MIT licensed. See [LICENSE](LICENSE).
