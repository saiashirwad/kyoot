# Independent contract review: Kyoot integrated core contracts

**Verdict: VERIFIED** — no proven blocking issue found in the requested contract scope.

**Revision under review:** `2d62944582de14f2f5d601f83399aab34beaf70c` (against `51f6619`). The checkout was at the reviewed SHA. Existing workspace status contained only the pre-existing untracked `.audit/cleanup/contracts-integrated.log`; I made no source changes.

## Intent reviewed

Repair same-key answer-contract unsafety (A11), preserve `undefined` during payload extraction (A12), make per-child handler state copying explicit and execute the copier for each inherited child (A13), and prevent `async`/`clock` effect rows with incompatible contracts from being erased by runner or stream boundaries. The documented trusted boundary for dependent built-ins remains in scope and is accepted.

## Method and verification

- Read `.audit/cleanup/contracts.md`, the cleanup handoff/todo/design notes, README contract notes, the commit diff, and surrounding implementation in `core.ts`, `model.ts`, `machine.ts`, `runtime.ts`, built-in effects, and core tests.
- Applied the interrogate correctness/root-cause/verification rubric and the strict code-quality lens; followed lead-judgment filtering. The review was deliberately single-reviewer per assignment. No child agents were started.
- `CI=true pnpm check` completed with exit code 0: format check, lint, all workspace typechecks, and all workspace test suites.
- `pnpm -F kyoot test` completed with exit code 0: 201 passed, 0 failed.
- The package typecheck includes the `.test-d.ts` contract probes. They cover same-key equal contracts, both literal answer widening directions, incompatible merged requirements, direct `makeHandler`, `resume.with` continuation constraints, undefined payload extraction, payload variance, and checked declaration handlers. The `@ts-expect-error` assertions remain in place; successful typecheck confirms the compiler saw errors at those sites rather than TS2578 unused directives.
- `git diff --check 51f6619 2d62944582de14f2f5d601f83399aab34beaf70c` passed.

## Findings

### Act on

None proven.

### Consider

None.

### Noted boundary

`fork: (state) => state` or a shallow copier that retains nested references can still share mutable objects. This is an explicit caller-controlled copier contract, not automatic deep isolation: the API invokes the supplied copier for every inherited child, while the caller defines what “copy” means. The README describes the copier requirement and the runtime regression demonstrates separate sibling and nested child state for its chosen copier. Keep that boundary in view when describing isolation guarantees.

The checked public `makeHandler` intentionally gives raw-key handlers `C = {}`, so `resume.with` accepts only effect-free continuation programs there. Richer continuation requirements stay on declaration-bound `Effect.handler`. The README and contracts note state this limitation. I found no counterexample that defeats the advertised restriction. Using `unsafeOp` or a manually raw row can leave answer information unavailable and fall through to `any`; that is consistent with the explicitly unchecked operation escape hatch, rather than a soundness guarantee for raw rows.

## Adversarial cases examined

- **`resume.with`:** checked raw-key hooks have an empty continuation row; the type-level `Only<S, keyof C>` restriction keeps nonempty effect rows out. Declaration-bound `handler` retains its declaration’s `C`. No evidence that `NoInfer<S>` lets hook inference widen the operation row.
- **Merged incompatible rows:** payload extraction distributes across `Requirement` alternatives, while answer extraction infers contravariantly from function parameters and therefore requires an answer valid for every alternative. Handler and interceptor negative probes exercise this case.
- **Forks:** runtime `crossed()` captures the active handler state; `inherit()` calls the state copier when constructing each child handler, not at snapshot capture. The regression checks two sibling children, a nested child, unchanged parent state, explicit `share`, and fresh `scope` behavior. `none` filtering remains at capture.
- **Reserved keys:** `ServedKeys<S>` removes only contracts compatible with the runner’s served row. `runPromise` and `Emit.toAsyncIterable` constrain their rows; `Async.fork`, `race`, and `all` preserve incompatible reserved requirements in their leftovers. Compile regressions cover each erasure path and the runtime’s existing dispatch remains key-based by design.
- **Trusted built-ins:** `Sync` and `Async` keep dependent raw rows and internal interceptors; `Var` keeps its explicitly dependent return behavior. I found no evidence that the new checked requirement witness can model those APIs without losing useful dependence, and the public raw escape hatches are named/documented as unsafe.

## Design judgment

The additions are localized to the canonical core contract, runtime fork inheritance, and the served-row boundary. The witness uses function-position fields to encode invariance without runtime identity changes. The runtime fork change is a small, direct clone-at-inheritance rule. The main cost is a few type-level helpers plus a parallel checked/unsafe handler entry point, but those boundaries correspond to real differences in safety and preserve the built-ins’ dependent signatures. I found no clear simpler restructuring that retains these contracts and constraints.

## Limits

This verifies the exact checked-in source through compile-time and runtime tests. It does not establish soundness in the presence of arbitrary TypeScript casts, `any`, forged raw rows, or a caller-supplied copier that intentionally aliases state; those are documented unsafe or caller-controlled boundaries.

Additional standalone compiler probe: compiled a temporary `/tmp` file with strict TypeScript and `@ts-expect-error` checks for invalid `AsyncOp` answers passed through `Async.fork`, `Async.race`, `Async.all`, and `Emit.toAsyncIterable`. The probe exited 0 with all four expected-error assertions consumed. (An initial invocation without `--allowImportingTsExtensions` failed on the repository’s `.ts` import convention; rerunning with that flag and `--types node` compiled successfully.)

A second standalone compiler probe checked `resume.with` directly: a pure success continuation is accepted by public raw-key `makeHandler`; an effectful failure continuation is rejected there (the expected-error assertion is consumed); the same continuation compiles through declaration-bound `Effect.handler` when that effect is in the declaration’s continuation row. This confirms the documented distinction with the actual compiler.
