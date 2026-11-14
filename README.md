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

| Package                                | Contents                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [`kyoot`](packages/kyoot)              | Core and `step`; entries `kyoot/fail`, `emit`, `env`, `log`, `random`, `resource`, `sync`, `var`, and `kyoot/async` for fibers |
| [`@kyoot/ai`](packages/ai)             | Language models, tools, and providers                                                                                          |
| [`@kyoot/platform`](packages/platform) | File system and process effects                                                                                                |

## Try it

Needs Node 22.18+, which runs the TypeScript directly.

```sh
pnpm install
node packages/kyoot/examples/step.ts
pnpm check
```

MIT licensed. See [LICENSE](LICENSE).
