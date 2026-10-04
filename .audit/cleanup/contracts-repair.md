# Checked contract repair

This repair supersedes the contract proof in `contracts.md`. The initial integrated implementation at `2d62944582de14f2f5d601f83399aab34beaf70c` was NOT VERIFIED. Independent review demonstrated intersection laundering, union dispatch erasure, and fixed/dependent Var crossing with compiler-accepted programs.

## Selected design and ownership

The coordinator selected Candidate A after independent Astra and Sol sketches and an independent cross-judge. Keep string dispatch, make each complete row entry invariant, and retain contravariant addition of independent keys. Reject the alternative of caller-owned symbol identities because it changes every declaration without solving enclosing row variance by itself. Whole-row invariance was also rejected because it prevents ordinary pure-to-effectful annotations and independent key extension.

`model.ts` owns row variance and composition inference. `core.ts` owns fixed/dependent contract distinction, singleton keys, checked extraction, and checked handler construction. Each built-in owns the relation between its payload and answer. The package exports one checked `makeHandler`; internal interpreter code explicitly imports `unsafeMakeHandler`.

Caller contracts:

- `Kyoot.succeed(1)` can be annotated with `EffectRow<'n', void, number>`. An n operation can acquire a separate s requirement through assignments, function arguments, returns, and pipe.
- The existing n entry cannot become an intersection, incompatible union, unknown, or open index row through annotation.
- `effect`, `Env.tag`, and `Var.tag` require a single known string identity. Checked `makeHandler` likewise requires one known key. Union, broad, open template, branded open string, and never keys reject. Explicit type arguments do not bypass these rules.
- The continuation row C cannot contain the performed key, including in one branch of a union or through a broad index signature.
- Fixed requirements and dependent families have disjoint discriminants. Sync, Async, Resource, and Var each carry a private unique-symbol family marker.
- Checked raw-key handlers accept only fixed requirements. For a genuine union of fixed contracts, the callback receives the payload union and resume requires the answer intersection. Declaration handlers and interceptors require the declaration's exact contract.
- `Sync.unsafeHandle`, `Sync.unsafeIntercept`, `Async.unsafeIntercept`, `Resource.unsafeIntercept`, and Var tag `unsafeIntercept` explicitly expose arbitrary dependent replacement. Ordinary built-in run/get/set/update/acquire operations retain their trusted implementation.

The guarantee excludes deliberate `any`, assertions, `unsafeOp`, `unsafeMakeIntercept`, dependent unsafe replacement APIs, direct internal imports outside the supported package exports, and the existing trusted `runFiber` boundary.

## Integration decisions

The phantom row witness special-cases the explicit `any` row so `AnyKyoot` remains the interpreter's erased type. Concrete rows still use invariant entry functions. `flatMap` and `Async.all` infer complete returned programs and merge their rows, rather than forcing different branches into one contextually inferred row. Runtime algorithms are unchanged.

A parameter typed never still accepts a value typed never. Constructors therefore check the one-element argument tuple as well as the key type. `keyof MergeAll<C>` detects overlaps in every continuation union branch. Env's private bridge asserts only the validated template key argument; no unchecked constructor is exported.

Payload and answer extraction inspect the private marker's function members. Matching `Requirement<P, any>` would fail for an invariant never answer and misclassify a real Fail requirement as a raw payload. Raw, dependent, and missing answers now extract to never; payload extraction retains undefined.

During built-in migration, two additional defects were reproduced before repair. `Emit.collect` accepted a fixed number-answer operation and resumed it with undefined. `Fail.run` reported a fixed marker as the runtime error payload. Emit now records `Requirement<E, void>` and Fail records `Requirement<E, never>`. Their checked interceptors remain available. Failure and emission collectors extract the actual payload. `Fail.catchTag` also rejects callbacks that require fields absent from the matching error.

Registry accepts the key/get projection it actually needs, instead of treating a concrete Env tag as an open string-ID tag. `NoInfer<E>` preserves the tag's value constraint on registration. Other downstream changes are explicit row annotations and Payload extraction. AI changes are limited to its generation row and one compile assertion; no AI behavior is changed.

## Execution checklist

- [x] Ground: trace core/model, built-in handlers, served runtime masks, and downstream annotations; read the initial independent counterexamples.
- [x] Sketch: use the coordinator's two independent designs and cross-judge; keep the selected invariant-entry design.
- [x] Agree: coordinator authorized implementation without a user checkpoint and accepted fixed Fail/Emit migration.
- [x] Reproduce: record unused expected-error directives before changing each affected contract.
- [x] Implement: migrate the core, all built-in dependent replacement names, and downstream type annotations.
- [x] Scrap review: no repeated workaround required a new architecture. The tuple key guard and program-return inference are recorded above.
- [x] Verify: rerun the four original adversarial programs, the compile fixtures, and full workspace checks.
- [x] Deslop: review the complete diff; retain executable expected-error directives and documented trusted boundaries. No new runtime guards or duplicate unchecked public constructors.
- [x] Commit: stage the regression fixture and its baseline evidence before the implementation commit.
- [x] Opening a PR: skip, coordinator explicitly requested local commits only, no push or PR.
- [x] Independent review: skip within this worker, coordinator reserved a fresh exact-commit adversarial review after integration. Self-check is not that independent verdict.

## Evidence

Logs are under `contracts-repair/` beside this document.

`initial-red.log` records 18 unused expected-error assertions before the first fix. `emit-fail-red.log`, `key-red.log`, and `extraction-red.log` preserve the subsequently discovered Emit/Fail, never/continuation-union, and extraction/callback failures before their repairs.

`baseline-regressions.log` compiles the final regression fixture against source extracted from `2d62944`. It reports 36 unused expected-error directives and a false raw-answer type assertion. These are the predicted disagreement, rather than runtime setup failures. Some final negative assertions already rejected on the initial baseline and remain regression coverage.

`original-probes-rejected.log` reruns all four independent counterexamples with only their import path redirected to this worktree. The compiler rejects the incompatible row assignments in intersection.ts and served-intersection.ts, the union key in union.ts, and the fixed handler applied to Var in var.ts.

`focused-green.log` records the core typecheck with all expected-error assertions active. `workspace-check.log` records `CI=true pnpm check`: format, lint, all five package typechecks, and 280 passing runtime tests. The counts are 201 core, 22 AI, 23 registry, and 34 platform. Registry's added type fixture also checks registration value preservation.

To rerun the maintained proof, run `CI=true pnpm check` from the workspace root. The compile fixtures are included by each package's tsconfig. Runtime test counts here describe this isolated repair branch, before the coordinator integrates its separate protocol work.
