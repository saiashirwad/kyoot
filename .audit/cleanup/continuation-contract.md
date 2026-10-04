# Fixed-effect continuation identity

This repair starts at `dd35814` and closes a gap left by the earlier checked-contract repair. A fixed requirement recorded payload, answer, and independent value types, but omitted its declaration's continuation row. Two same-key declarations with identical payload and answer types could therefore disagree about the effects permitted in `resume.with`.

The original strict probe in `continuation-contract/original-probe.mts` has no type assertions, explicit `any`, or unsafe API. Before this repair it compiles, then demonstrates both failures:

- A handler adds an `s` continuation to a plain operation while its result is typed as pure; running it throws an unhandled `s` effect.
- A number continuation is handled by a declaration expecting a string continuation; an outer numeric `s` handler supplies `7`, the string continuation reads its `.length`, and the program returns `undefined` despite its declared `number` result.

## Selected contract

`Requirement<P, A, V, C>` now includes an invariant continuation witness, `(row: C) => C`, alongside the existing invariant fields. The fourth parameter preserves the existing meaning of the third parameter `V`. The default continuation is `{}`.

`EffectRow<K, P, A, C, V>` mirrors the declaration's `effect<P, A, C, V>` parameter order after the key. It describes the operation's own entry; the performed program additionally carries `C` as separate requirements. The marker is phantom data and adds no runtime allocation.

The coordinator selected exact continuation identity after the independent review in `continuation-contract-design-review.md`. Merely adding `C` to handler output would overapproximate continuation effects and still permit incompatible declarations to replace one another. Exact identity preserves the existing contract rule and the existing behavior where a handler around the operation site handles a supplied continuation.

`effect` carries the exact `C` through its performed requirement, `handle`, `handler`, and `intercept`. `Resume.with` retains its existing answer and allowed-row checks. Nesting a continuation-capable operation inside another `resume.with` now preserves its continuation identity too.

Checked raw-key `makeHandler` remains conservative: it extracts the payload union and answer intersection, and gives `resume.with` an empty continuation row. It can safely resume a union of differing continuation contracts with a pure answer, but cannot introduce continuation effects. Interceptor callback effects remain visible in its returned requirement row. No raw handler or resume contract was weakened.

Only one downstream source annotation required migration: `Node.provide` now spells the `CommandError` continuation already declared by `Command`. `Log` and the AI fixed declarations use the default empty continuation. No interpreter, platform, AI, or provider behavior changed.

## Verification

The red fixture and baseline logs were committed first as `3f0b7b2`, before production edits. Evidence is retained in `continuation-contract/`:

- `baseline-probe-types.log`: successful strict compilation of the original probe on the baseline; the compiler produces no diagnostics.
- `baseline-probe-runtime.log`: the original probe's unhandled-effect and wrong-result assertions pass, recording the actual `undefined` result.
- `baseline-types.log`: 19 unused expected-error directives across declaration handlers/interceptors, requirement entry assignment, row annotations, intersections, unions, nested `resume.with`, and function argument/return/pipe boundaries. Two other rejection checks already held and remain regression coverage.
- `downstream-annotation-red.log`: after the witness change, the existing platform example exposes the incomplete Command annotation before its correction.
- `focused-green.log`: all five package typechecks pass, including the maintained negative fixture and explicit public generic-order assertions.
- `original-probe-rejected.log`: strict compilation now rejects both incompatible declaration handlers in the original probe.
- `positive-runtime.log`: 41 focused tests pass. New tests cover matching continuation declarations through handle/handler/intercept, handlers inside and outside the operation, nested continuations, and raw-key unions receiving pure answers. The existing failure-at-operation-site test also passes.
- `workspace-check.log`: `CI=true pnpm check` passes formatting, lint, all five package typechecks, and 307 runtime tests: 204 core, 44 AI, 23 registry, and 36 platform.

The maintained proof runs with `CI=true pnpm check`. To confirm the original program is rejected, run:

```sh
pnpm exec tsc --ignoreConfig --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext --allowImportingTsExtensions --skipLibCheck --types node .audit/cleanup/continuation-contract/original-probe.mts
```

This command must exit unsuccessfully with the incompatible-handler errors; it is intentionally outside the package test suite.

## Bounds and review

This remains a structural, checked-API guarantee. Assertions, explicit `any`, unsafe APIs, direct internal imports, and existing trusted runtime boundaries retain the exclusions documented in `contracts-repair.md`.

The independent design review also examined disjoint union continuation rows. Their exposed keys are conservative: the performed row and `Resume.with` use common keys, and branch-only effects cannot be supplied through `Resume.with`. This repair does not claim more permissive union-continuation support and does not expand that behavior without a concrete wrong-result reproduction.

The writer reviewed the source diff for unnecessary comments, casts, guards, and compatibility scaffolding. New code comments are executable expected-error directives in the regression fixture. The coordinator owns the fresh final adversarial verification and formal no-comments review after integration; this writer's checks do not replace those reviews.

## Optional continuation keys

The first final independent reviews passed required continuation rows. A coordinator strict probe then found that {} and a row containing only optional fields are mutually assignable. An invariant value witness alone therefore failed to preserve an optional continuation key. The maintained negative fixture first produced three unused expected-error directives. An invariant keyof C witness now preserves the key domain as well as the row values. The same-declaration optional continuation remains a valid positive control. optional-continuation-red.log and the baseline runtime log retain the missed case.

Putting keyof C in the original interface still allowed TypeScript's generic variance comparison to skip that derived distinction. Requirement now aliases a private five-parameter shape whose key-set argument is computed from C. The independent key-set argument participates directly in invariant comparison. The public Requirement keeps its four-parameter API; callers cannot override the computed key-set argument. optional-keys-first-attempt.log records the discarded embedded-witness attempt.

The independent optional review found a second path through a plain outer-row annotation. The initial key witness closed declaration equivalence but optional outer keys still disappeared. Making the entire Kyoot witness required broke generic internal AnyKyoot inference and was discarded. The selected repair materializes permitted continuation keys with Required<C> in Performed, preserving declaration identity while keeping every permitted key in the performed row. Direct, generic, union, mapped, and wrong-answer regressions cover this boundary.

A later strict union probe showed Required<C> still preserved alternative row branches. An annotation selected the string branch while an exact handler resumed the number branch. The performed continuation row now uses MergeAll<Required<C>> to retain each key with all its possible requirements. The retained union-continuation-red.log demonstrates the narrowing defect and union-continuation-green.log records rejection after normalization. Earlier optional verdicts are superseded.
