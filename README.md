# kyoot

An experimental, minimal Effects system for Typescript heavily inspired by Kyo

| Package                                | What                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| [`kyoot`](packages/kyoot)              | The core: algebraic effects for TypeScript, handlers, fibers, and the built-in effects |
| [`@kyoot/ai`](packages/ai)             | Language models, tools, and providers as effects                                       |
| [`@kyoot/platform`](packages/platform) | File system and processes as effects, with handlers per runtime                        |
| [`@kyoot/registry`](packages/registry) | Components that load, unload, and hot swap at runtime                                  |

```
pnpm install
pnpm typecheck
pnpm test
```

Benchmarks live in `packages/bench`: `pnpm bench` compares kyoot against Effect,
and `pnpm -F @kyoot/bench bench:async-batch` reports time, sampled bytes per run,
and sampled bytes per item for 100 separate `Async.fromPromise` waits against the
`Async` Promise batches on Node 24.
