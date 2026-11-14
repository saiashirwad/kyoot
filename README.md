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

## Try it

Needs Node 22.18+, which runs the TypeScript directly.

```sh
pnpm install
node packages/kyoot/examples/step.ts
node packages/kyoot/examples/sim/tickets.ts   # a race found by a seeded scheduler, then run live
pnpm check
```

MIT licensed. See [LICENSE](LICENSE).
