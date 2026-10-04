# FileSystem answer contract

The baseline is commit `800c86e`. `FileSystem.readFile` promised `string` while
its row advertised a fixed `unknown` answer. Five paths compiled without `any`
or casts and produced a value other than a string: the FileSystem `handle`,
`handler`, and `intercept` APIs, an ordinary `effect<Op, unknown>()("fs")` handler,
and the checked `makeHandler("fs", ...)` builder.

## Alternatives

1. Keep the fixed row and rename the three callbacks. This names their unsafe
   behavior but leaves ordinary fixed-answer handlers able to consume the row.
   Rejected because it does not close the reproduced hole.
2. Build a checked handler table with one callback per operation kind. Each
   callback could preserve its payload and answer relation, but state, completion
   hooks, error delivery, and interceptor forwarding need a separate public
   contract. This is useful future API work, but is larger than this repair.
3. Give the row a private dependent-family identity and expose the existing raw
   callbacks through explicit unsafe names. Chosen because it matches the core's
   dependent Sync and Var contracts and preserves existing interpreter behavior.

## Implementation

`FileSystemRow` uses `DependentRequirement<Op, unknown, typeof family>` with a
module-private unique symbol. The ordinary checked builders reject that kind of
requirement. `Memory.fs`, `Node.fs`, and `Node.provide` accept this row explicitly.
The private `perform` function is the trusted operation constructor and retains
the discriminant-to-answer mapping. Its assertion bridges the raw operation
builder to the dependent requirement.

`unsafeHandle`, `unsafeHandler`, and `unsafeIntercept` accept unknown answers.
Their caller must preserve the result contract for the actual operation.
Built-in handlers and every existing interception example use these names.
There are no legacy aliases. The core index exports its existing
`unsafeMakeHandler`, `DependentRequirement`, and `Hooks` definitions so platform
can use the same contract without duplicating its shape. The core implementation
is unchanged.

The coordinator's identical `Emit.intercept<Events.Event>()` migration is included
in `packages/ai/test/providers.test.ts` so the integrated invariant row contract
passes the workspace typecheck. It changes test types only.

## Evidence

The executable baseline fixture is `filesystem-contract-repro.ts`. Run it before
the repair with:

```sh
pnpm exec tsc --ignoreConfig --strict --noUncheckedIndexedAccess --target es2022 --module nodenext --moduleResolution nodenext --types node --noEmit --allowImportingTsExtensions --skipLibCheck .audit/cleanup/filesystem-contract-repro.ts
node .audit/cleanup/filesystem-contract-repro.ts
```

The strict compiler exited 0. The runtime exited 0 after asserting the five
incorrect values, recorded in `filesystem-contract-before-runtime.log`.
The fixture intentionally keeps the old APIs and must fail compilation after
the repair. It is outside package source and test includes.

Before implementation, all ten negative type checks in `fs.test-d.ts` failed
with unused `@ts-expect-error` directives. `filesystem-contract-red.log` records
that failure. After implementation, they pass and the unchanged baseline fixture
fails compilation. Positive checks cover all operation result types, filesystem
rows preserved in annotations, both built-in interpreters, `Node.provide`, and
pure programs.

Runtime tests exercise state and completion hooks, failure delivery, both
built-in interpreters, and migrated interceptors. Filesystem persistence,
command output limits, and unrelated behavior remain outside this repair.

`filesystem-contract-workspace-check.log` records the final `CI=true pnpm check`:
format, lint, all five package typechecks, and 304 passing runtime tests
(201 core, 23 registry, 44 AI, and 36 platform). A focused platform typecheck and
all 36 platform tests also passed before the workspace run.

The final diff review retained the private assertion that constructs the
dependent row, without adding runtime guards or `any` casts. The only new code
comments are the ten executable negative type assertions. The coordinator owns
the independent exact-commit review, including the fresh no-comments pass;
all agent slots were occupied during this worker's validation.
