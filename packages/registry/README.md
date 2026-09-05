# @kyoot/registry

```ts
import * as Registry from "@kyoot/registry";
import { Env, Kyoot, Resource } from "kyoot";
```

`@kyoot/registry` turns programs into components that can be loaded, unloaded, and swapped while the rest keeps running. A component declares the `Env` tags it needs and a program that sets it up; the setup's `Resource.acquire`s are undone in reverse when the component is unloaded. A component provides a value to others with `ctx.set(tag, impl)`, which is itself a resource, so it is withdrawn on unload. When a provider appears, dependents whose needs are now met activate; when it goes, they deactivate first, while its bindings are still readable.

Here, `open`, `close`, `listen`, `stop`, and `database2` stand in for app code.

```ts
const Db = Env.tag<{ query: (sql: string) => string }>()("db");

const database = Registry.component({
  inject: {},
  run: (_, ctx) =>
    Kyoot.gen(function* () {
      const conn = yield* Resource.acquire(open, close);
      yield* ctx.set(Db, { query: (sql) => conn.run(sql) });
    }),
});

const server = Registry.component({
  inject: { db: Db },
  run: ({ db }) => Resource.acquire(() => listen(db), stop),
});

const main = Kyoot.gen(function* () {
  const registry = yield* Registry.make(); // a resource: disposed when the scope ends
  const srv = yield* registry.use(server); // inactive: nothing provides Db yet
  const db = yield* registry.use(database); // server activates once the database has landed
  yield* db.remove(); // server deactivates, then the database closes
  yield* registry.use(database2); // server comes back on the new one
}).pipe(Resource.run);
```

`use` returns a handle with `active`, `error`, and `remove`, and resolves once the component has landed (its setup finished) or been found to be waiting. A component's bindings become visible to dependents only when it lands, so activation is atomic; a target change during setup interrupts it and releases what it acquired. A component's `run` may use `resource`, `async`, and `clock`; anything else must be handled inside it. A component whose setup throws — including providing a tag another component already provides — is left inactive with the error on its handle. The registry itself is a resource, so interrupting the program that made it unloads every component in reverse order. `examples/registry.ts` runs this sequence. The design follows the component calculus of the Cordis paper: revertible effects (`Resource`) plus reactive dependencies.

## Lifecycle

Entries move through waiting, starting, active, stopping, failed, and removed states. Each transition carries a generation so stale setup work cannot publish a binding after removal or replacement. Tag identity uses its key, so two tag objects with the same key refer to the same binding.

`settled()` waits for current setup, teardown, and reconciliation work to finish. It does not freeze the registry against later changes. A failed component retains its error and retries when its dependencies change; the failure alone does not start a retry loop.

`dispose()` is terminal and awaits teardown. Later attempts to add work fail with `RegistryDisposedError`; calling dispose again is safe. Components and registry state are fresh each time the maker program runs. Teardown awaits resource cleanup and has no deadline, so a release that never finishes can prevent settling or disposal.

Requires Node 24+ and TypeScript 7.0.2. See the complete [registry example](examples/registry.ts), which uses public package imports and runs in `pnpm examples`.
