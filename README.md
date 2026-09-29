# kyoot

Experimental effects for TypeScript, inspired by [Kyo](https://github.com/getkyo/kyo). No stability promise.

A program's type carries a typed effect row: the effects it still needs. Each handler you `.pipe()` in removes the effects it covers (and may add its own), and `runSync` / `runPromise` only type-check once the row is empty.

```ts
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

| Package                                | What                                                  |
| -------------------------------------- | ----------------------------------------------------- |
| [`kyoot`](packages/kyoot)              | Core: effects, handlers, fibers, built-in effects     |
| [`@kyoot/ai`](packages/ai)             | Language models, tools, and providers as effects      |
| [`@kyoot/platform`](packages/platform) | File system and processes as effects                  |
| [`@kyoot/registry`](packages/registry) | Components that load, unload, and hot swap at runtime |

Not published; clone the repo. Requires Node 22.18+ (runs `.ts` directly).

```
pnpm install
node packages/kyoot/examples/checkout.ts
pnpm check
```

License: MIT (see [LICENSE](LICENSE)).
