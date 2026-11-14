# kyoot

Typed algebraic effects for TypeScript. A program's type lists the effects it still needs, and handlers are plain functions that discharge them. `Kyoot.step` lets any host drive a program one effect at a time.

```ts
import { effect, Kyoot } from "kyoot";

const Ask = effect<string, string>()("ask");

const program = Kyoot.gen(function* () {
  const name = yield* Ask("name?");
  return `hello ${name}`;
}); // needs the "ask" effect

// the host answers each request itself
let step = Kyoot.step(program);
while (!step.done) step = step.resume("ada");
console.log(step.value); // hello ada

// or handle it inside the program and run it directly
const handled = program.pipe(Ask.handle((_question, resume) => resume("ada")));
console.log(Kyoot.runSync(handled)); // hello ada
```

## Packages

| Package                                | Contents                                                                                                                                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`kyoot`](packages/kyoot)              | Core and `step`; entries `kyoot/fail`, `emit`, `env`, `log`, `random`, `resource`, `sync`, `var`, `kyoot/async` for concurrency effects and the live driver, and `kyoot/sim` to run the same programs on a seeded scheduler |
| [`@kyoot/ai`](packages/ai)             | Language models, tools, and providers                                                                                                                                                                                       |
| [`@kyoot/platform`](packages/platform) | File system and process effects                                                                                                                                                                                             |

## Concurrency

Forking, joining, interrupting and sleeping are effects too (`fiber/*`, `clock/*`), so one program has two drivers: `runPromise` answers them with real fibers and timers, and `Sim.run` with a seeded scheduler and virtual time. Your own effects (a database, `fs/*`, `ai/model`) get a live handler in production and a fake `world` in simulation.

```ts
const both = Async.all([buyTicket("alice"), buyTicket("bob")]);
Sim.explore(both, { seeds: 1000, world, check: noOversell }); // finds, replays and shrinks the race
await runPromise(both.pipe(Async.provide(liveDb))); // the same program, for real
```

Handlers don't cross a fork. A fork leaves its program's unhandled effects in the parent's row twice, as `db/get` and as a `fork/db/get` marker. A plain `Db.handle` removes only the first, so the type still asks for the second; `Async.provide(handler)` installs the handler in every fiber and removes both, and a simulation's `world` answers both. `provide` only takes handlers that keep the program's value (a service, not `Log.collect`).

In a simulation a world responder can fail with the program's typed error: return `Sim.fail(new FsError(...))`. While `Sim.run` (and `explore`/`shrink`) executes, `Date.now`, `performance.now`, `Math.random`, timers, `fetch` and `crypto` randomness throw, because they would break determinism; pass `{ guard: false }` to turn that off. The guard covers the run only, not module-level code or `new Date()`.

## Conventions

A handler is named for what it does to the effect it discharges. `X.run` is the default (or only) handler and runs the program with X discharged (`Fail.run`, `Var.run`, `Resource.run`, `Sync.run`). Alternatives are named by behaviour, one name per behaviour across effects: `live` (real world), `virtual`, `manual` and `seeded` (controlled), `print` (to the console), `forEach(f)`, `collect`, `discard`; `provide` supplies a service. Non-handlers do not look like handlers (`Retry.retry`).

Each operation of an effect is its own effect with its own key: `Var` has `var/<id>/get`, `var/<id>/set` and `var/<id>/update`, and `Count.intercept.set(...)` touches only sets.

## Try it

Needs Node 22.18+, which runs the TypeScript directly.

```sh
pnpm install
node packages/kyoot/examples/step.ts
node packages/kyoot/examples/sim/tickets.ts   # a race found by a seeded scheduler, then run live
pnpm check
```

MIT licensed. See [LICENSE](LICENSE).
