# kyoot

An experimental effects system for TypeScript, inspired by [Kyo](https://github.com/getkyo/kyo). The API may change.

A program's type tracks its unhandled effects. You supply handlers with `.pipe()`. Each handler removes the effects it handles and may introduce effects of its own. `runSync` requires all effects to be handled; `runPromise` also accepts `Async` and `Clock`, which its runtime handles for you. TypeScript checks these requirements when you call either runner.

Here, the program needs a config and a greeting. Providing just the config leaves the greeting unhandled:

```ts
import { Env, Kyoot } from "kyoot";

const Config = Env.tag<{ id: string; name: string }>()("Config");
const Greeting = Env.tag<string>()("greeting");

const program = Kyoot.gen(function* () {
  const config = yield* Config;
  const greeting = yield* Greeting.get();
  return { config, greeting };
});

Kyoot.runSync(program.pipe(Config.provide({ id: "hi", name: "what" })));
// type error: program still has Unhandled<"env/greeting">

Kyoot.runSync(program.pipe(Config.provide({ id: "hi", name: "what" }), Greeting.provide("hi")));
// { config: { id: 'hi', name: 'what' }, greeting: 'hi' }
```

## Packages

| Package                                | Contents                                        |
| -------------------------------------- | ----------------------------------------------- |
| [`kyoot`](packages/kyoot)              | Effects, handlers, fibers, and built-in effects |
| [`@kyoot/ai`](packages/ai)             | Language models, tools, and providers           |
| [`@kyoot/platform`](packages/platform) | File system and process effects                 |
| [`@kyoot/registry`](packages/registry) | Loading and hot swapping components at runtime  |

## Try it

The packages aren't published yet. Clone the repo and use Node 22.18+ to run the TypeScript examples directly:

```sh
pnpm install
node packages/kyoot/examples/checkout.ts
pnpm check
```

The [checkout example](packages/kyoot/examples/checkout.ts) shows how to define your own effects and supply different handlers. There are more examples in [packages/kyoot/examples](packages/kyoot/examples).

MIT licensed. See [LICENSE](LICENSE).
