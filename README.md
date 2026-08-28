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

## Async allocation profile

Node 24 can measure the 100-operation async path without loading Effect or
mitata:

```
pnpm -F @kyoot/bench profile:async
```

The command reports steady-state time, median sampled bytes per run, the
largest sampled run, and kyoot-owned allocation sites. It subtracts an empty
sampling pass from each result. The four cases separate construction, the
pump over a shared input Promise, fresh input Promise allocation, and the
end-to-end path.

Use one case when recording Node CPU or heap profiles:

```
node --cpu-prof --expose-gc packages/bench/async-alloc.ts --scenario=pump-fresh
node --heap-prof --expose-gc packages/bench/async-alloc.ts --scenario=end-to-end
```

The harness disables its own allocation sampler when either Node profiler is
active. Generated `*.cpuprofile` and `*.heapprofile` files are ignored.
