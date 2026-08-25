# kyoot

A pnpm workspace.

| Package                                | What                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| [`kyoot`](packages/kyoot)              | The core: algebraic effects for TypeScript, handlers, fibers, and the built-in effects |
| [`@kyoot/ai`](packages/ai)             | Language models, tools, and providers as effects                                       |
| [`@kyoot/registry`](packages/registry) | Components that load, unload, and hot swap at runtime                                  |

```
pnpm install
pnpm typecheck
pnpm test
```

Examples run directly: `node packages/kyoot/examples/checkout.ts`.
