# Fresh independent checked-contract review

**VERDICT: VERIFIED**, bounded to ordinary strict TypeScript use of the checked package API at `/Users/texoport/code/kyoot-cleanup`, commit `df093065096b7c2714eed0ccfabb71f9cca8cc23`. I made no repository source edits or commits. This is a structural contract verdict, not a blanket claim of TypeScript soundness. It excludes explicit `any`, assertions, named `unsafe*` APIs, direct internal imports, and the existing trusted `runFiber` boundary.

## Source reasoning

`Requirement<P, A, V, C>` includes an invariant `(row: C) => C` witness. The performed program carries both the fixed requirement entry and its continuation row. The declaration's `handle`, `handler`, and `intercept` require that same entry; `makeIntercept` carries `C` into `next`. A row's present entries remain invariant in `Kyoot`'s phantom witness, so assigning or composing under a different continuation contract cannot erase this identity. `Resume.with` checks both the answer and allowed continuation keys. Checked `makeHandler` extracts the union of payloads and intersection of fixed answers, but sets `C` to `{}`: it can resume a mixed contract with a pure answer and cannot inject a continuation effect. Its result retains unhandled independent requirements and callback effects. Dependent FileSystem operations have a private family and cannot enter the fixed checked handlers.

## Independent evidence

- The exact original no-cast/no-`any` continuation program in `.audit/cleanup/continuation-contract/original-probe.mts` failed strict TS7 compilation at both incompatible declaration handler applications (lines 7 and 15). The compiler also reports a downstream unhandled/unknown value after the second failure. The original pure false row and wrong numeric result therefore do not typecheck.
- My separate 34-negative-assertion strict probe, `/tmp/kyoot-contracts-final-sol-probe.mts` (SHA-256 `566798d9f897fb1003a8abb9485c550a61cf995ae0d1200ba12e4dd83b5319a3`), compiled with no unused `@ts-expect-error`. It covers missing/wrong `C` through declaration handlers, direct handlers, and interceptors; a pure false row; incompatible same-key union `C`; explicit union `C` with differing answers; disjoint union `C` with a branch-only effect; raw `makeHandler` answer and `Resume.with` restrictions; and preservation of the independent `s` row. Generic `C` inference retained the number continuation and rejected a string continuation and a two-entry generic unification. The probe uses no casts or explicit `any`; `type Kyoot as K` is only an import alias.
- That probe also rechecked old intersection/union row laundering, broad/union keys, continuation key collisions, fixed/dependent Var/Sync/Async/Resource crossing, Emit/Fail answer contracts, and dependent FileSystem crossing. Its positive cases compiled matching declarations, nested `resume.with`, independent row extension, pure-to-effectful annotation, and an Env provider.
- All five prior `/tmp/kyoot-astra-probe/{intersection,union,probe,served-intersection,var}.ts` programs failed strict compilation at their intended contract boundary. The old `.audit/cleanup/filesystem-contract-repro.ts` also failed strict compilation: old public handler/interceptor names are absent, and the fixed/raw handlers cannot consume the dependent FileSystem row.
- My positive runtime probe, `/tmp/kyoot-contracts-final-sol-runtime.mts` (SHA-256 `783aa47b428f96d1b3b4eff7291e6206d1c85e2225e41688842a49565389d041`), passed strict compilation and execution. It exercised matching declaration handlers and `intercept`, inside/outside source handlers, nested continuation, an independent effect, and raw-key pure resumption over differing continuation contracts. The asserted numeric results were 13, 13, 13, 14, and 10.
- `CI=true pnpm -F kyoot typecheck` and `CI=true pnpm -F @kyoot/platform typecheck` passed. `CI=true pnpm -F kyoot test` passed 204/204; `CI=true pnpm -F @kyoot/platform test` passed 36/36.

The strict standalone invocation used `pnpm exec tsc --ignoreConfig --noEmit --strict --noUncheckedIndexedAccess --target es2022 --module nodenext --moduleResolution nodenext --allowImportingTsExtensions --skipLibCheck --types node <probe>`. The maintained package typechecks include their negative fixtures, and TypeScript reports unused expected-error directives.

The earlier Sol and Luna reports at `800c86e7bdf28b12d13a1bb54a8beacdbcf46eb5` verified the original checked core contract repair and explicitly excluded the separate FileSystem hole. They did not cover this later continuation change. This verdict is based on the current source and new probes, with that older scope kept distinct. The proof notes in `.audit/cleanup/contracts-repair.md`, `.audit/cleanup/filesystem-contract-design.md`, and `.audit/cleanup/continuation-contract.md` agree with the checked boundaries tested here.

## Source fingerprints

SHA-256 at review time:

```text
de45d61acf2db85aa3f3873c5c46bf890a6d8f5ffe6bdc741a6c05d5d4f45339  packages/kyoot/src/core.ts
f968f59551104e032d88116ad05ea25368e19a91e05107c02f299708e87baac9  packages/kyoot/src/model.ts
587ce1199614297f5f754321ca8da94bcda81456dd5c51ee36a5e6c6243115fd  packages/kyoot/src/types.ts
cfb5202ece06b5d051c9b96cbd8bc0774ee323a6dd51b798a2c1cb713c817868  packages/kyoot/src/index.ts
4f270c0376bc8fee45c66cac523c3bc02a8b3b02e0073e2d5d70cf1a81f40dcd  packages/platform/src/fs.ts
9dbaaab1474d1220496ec2dd260186063ae29cfb2a2df3da7b9260a0dafad70d  packages/platform/src/node.ts
615ba4e776f411cf4d0011fd78053c3e534206863d733ffe3c5d35d66de1ee24  packages/kyoot/test/continuation-contract.test-d.ts
d7bcde1a055ac47044a8987d4e9d226e3274b0c20e03f24747f4408b2dc966f7  packages/kyoot/test/contract-repair.test-d.ts
daff72757227bfea28cab5c034c6da55e3eb969663e1164f922ed0b26bb94e6d  packages/platform/test/fs.test-d.ts
```
