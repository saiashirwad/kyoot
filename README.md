# kyoot

A small, open effect system for building programs whose operations can be interpreted, intercepted, tested, and composed independently of their implementation.

| Package                                | What                                                            |
| -------------------------------------- | --------------------------------------------------------------- |
| [`kyoot`](packages/kyoot)              | Operations, handlers, fibers, failures, resources, and streams  |
| [`@kyoot/ai`](packages/ai)             | Language models, tools, and providers as effects                |
| [`@kyoot/platform`](packages/platform) | File system and processes as effects, with handlers per runtime |
| [`@kyoot/registry`](packages/registry) | Components that load, unload, and hot swap at runtime           |

```sh
pnpm install
pnpm check
pnpm examples
pnpm pack:smoke
```

A program declares what it needs. Handlers choose what each operation means. Rows are plain payload maps; they track declared Kyoot operations, not arbitrary JavaScript side effects.

```ts
import { Async, effect, Kyoot } from "kyoot";

const Greeting = effect<string, string>()("greeting");
const welcome = Greeting("Ada").map((text) => `${text}!`);
const deterministic = Greeting.handle({
  onOp: (name, resume) => resume(`Hello, ${name}`),
});
const live = Greeting.handle({
  onOp: (name, resume) =>
    Async.fromPromise(async (signal) => {
      const response = await fetch(
        `https://example.com/greeting?name=${encodeURIComponent(name)}`,
        { signal },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    }).flatMap(resume),
});
const uppercase = Greeting.intercept((name, next) => next(name).map((text) => text.toUpperCase()));

console.log(welcome.pipe(uppercase, deterministic, Kyoot.runSync)); // HELLO, ADA!
// To use your HTTP endpoint: await welcome.pipe(uppercase, live, Kyoot.runPromise).
```

`map` keeps its callback's result as a value. `flatMap` runs the program the callback returns. Constructing a program does not execute it; a runner does. The [compiled domain example](packages/kyoot/examples/domain.ts) contains both handlers above.

Read [Getting started](docs/getting-started.md) for construction and execution, and [Design](docs/design.md) for continuation and cleanup rules.

Requires Node 24 or later. TypeScript 7.0.2 is the supported and pinned compiler; older compilers are not tested. Packages ship ESM, declarations, and source maps. `kyoot/internal` is a trusted implementation boundary for satellite packages.

`pnpm examples` runs deterministic examples. Network calls, process exit, and live providers stay in separate examples and require an explicit run. Benchmarks have small default smoke runs and opt-in heavy runs under `packages/bench`.

MIT. Inspired by [Kyo](https://getkyo.io).
