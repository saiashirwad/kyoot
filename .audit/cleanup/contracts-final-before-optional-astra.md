# Independent final checked-contract verification

**VERIFIED for the bounded checked-contract repair at `df093065096b7c2714eed0ccfabb71f9cca8cc23`.** The original continuation counterexamples now reject under strict TypeScript. Fresh continuation, inference, union, row, key, dependent-family, and filesystem probes did not reproduce a false-pure program or incompatible answer within the checked surfaces tested below. Core and platform typechecks pass; all 204 core and 36 platform runtime tests pass.

This is an exact-source, bounded verification, not a claim that arbitrary TypeScript programs or the entire library are sound. Explicit `any`, type assertions, named unsafe APIs, direct internal-module construction, and the existing trusted `runFiber` boundary remain excluded. Built-in filesystem behavior beyond its repaired answer-contract separation was not audited exhaustively. No source files were changed and no commits were created. All new probes and this report are under `/tmp`.

## Independent source review

I read `continuation-contract.md`, `contracts-repair.md`, and `filesystem-contract-design.md`, then reviewed the current implementation and the continuation diff from `dd35814`. I completed my source and adversarial checks before reading the earlier Sol/Luna verdicts.

- `core.ts:103–109`: `Requirement<P,A,V,C>` records a function-valued `(row: C) => C` witness. Under strict function checking it preserves the continuation contract invariantly, including nested requirement entries. The third argument remains `V`; `C` is fourth. `EffectRow<K,P,A,C,V>` deliberately follows declaration order after the key.
- `core.ts:217`, `:227`, `:231`, and `:247`: performed programs, `handle`, `handler`, and `intercept` all use `Requirement<P,A,V,C>`. The interceptor's forwarded operation has the same complete identity. No checked declaration path reviewed still uses the old incomplete marker.
- `core.ts:93–98`: `Resume.with` checks both the returned answer and permitted row. Nested continuation identity reaches this check through the fixed entry in `C`.
- `core.ts:302–330`: checked raw-key `makeHandler` still extracts the payload union and answer intersection from fixed entries and deliberately supplies `C={}`. Its `resume.with` accepts only a pure program with a compatible answer. It cannot borrow an effectful continuation from any constituent declaration.
- `model.ts:82–89`: each existing entry remains invariant while independent requirement addition remains available; composition merges complete returned program rows.
- FileSystem retains its private dependent family and explicit unsafe replacement names. Fixed declaration handlers and checked raw-key handlers cannot consume its dependent row; Memory, Node.fs, and Node.provide reject fixed lookalikes. `Node.provide` now records Command's actual failure continuation.

The source diff adds no runtime branch, allocation, general suppression, or unchecked checked-API alias. It changes the phantom continuation identity and the one downstream Command annotation.

## Strict rejection evidence

Compiler: TypeScript 7.0.2. Runtime: Node v26.10.0. Standalone probes use `--strict --noUncheckedIndexedAccess --target es2022 --module nodenext --moduleResolution nodenext --noEmit --allowImportingTsExtensions --skipLibCheck`, with Node types and `--ignoreConfig`. Positive and negative probe programs use public entrypoint exports and contain no assertions, explicit `any`, or unsafe calls. Each primary negative program was compiled independently without suppressed diagnostics.

The matrix has **65 independently compiled programs: 64 reject, and one accepted union case is a valid conservative control described below**. This consists of 43 fresh programs and 22 retained programs. Diagnostics were inspected for the intended API rejection, rather than treating arbitrary compiler failure as success.

The unchanged original files `/tmp/kyoot-contract-final-probes/continuation.mts` and `continuation-handler.mts` now reject. The former rejects both the false-pure `handle` and the number/string continuation replacement; the latter rejects the incompatible direct `handler` argument. The committed original probe rejects as well. This closes the blocker recorded in `/tmp/kyoot-contract-final-check.md` for `dd35814`.

Fresh probes reject missing, added, and incompatible continuation contracts through all three declaration APIs; perform-row annotation erasure; intersection and union strengthening; declaration handling of mixed `gen` and `flatMap` contracts; wrong nested `resume.with`; explicit empty-row replacement; operation-key overlap hidden in a continuation union; and interceptor-effect erasure. Generic `C` identity inference preserves the concrete row. Pair inference cannot unify incompatible continuations, and explicit `{}` or union type arguments cannot erase or widen the existing contract.

Raw-key negative probes reject effectful `resume.with`, wrong pure answers, effectful replacement of mixed continuation declarations, incompatible union answers, and a conditional program with disjoint effect rows.

Retained negatives still reject same-key answer/row intersections, union and open-row laundering, union/broad keys, self-key continuation overlap, fixed replacements for Var/Sync/Async/Resource/FileSystem, raw-key FileSystem replacement, and fixed FileSystem lookalikes passed to Memory, Node.fs, and Node.provide. The original five-path filesystem fixture still fails compilation. Maintained package fixtures additionally verify template/branded/never keys, explicit generic key arguments, Emit/Fail contracts, payload extraction, and invalid failure callbacks.

Artifacts:

- `/tmp/kyoot-contracts-final-astra-probes.py`: generates and runs the first 58 programs.
- `/tmp/kyoot-contracts-final-astra-probes/results.json` and per-case logs: initial matrix, 57 rejected plus one conservative accepted union control.
- `/tmp/kyoot-contracts-final-astra-probes/union-results.json` and per-case logs: seven additional rejected union boundary probes.
- `/tmp/kyoot-contracts-final-astra-probes.log`: compact first-matrix diagnostics.

## Union continuation result

For `C = EffectRow<'s',void,number> | EffectRow<'s',void,string>`, `resume.with` may select the numeric branch. This accepted case is not a mismatch: the resulting program still requires `{s: Requirement<void,number> | Requirement<void,string>}`. A compile-time equality assertion confirms that exact row. Both narrow declaration handlers reject it, raw resume requires the impossible number/string intersection, and `runSync` rejects the unhandled `s`. A checked raw handler that deliberately aborts with `Kyoot.succeed(27)` runs and returns 27, which agrees with its type.

For disjoint continuation unions, only common keys can be supplied through `resume.with`; branch-only effects reject. A pure continuation is accepted and runs. This is conservative support, not a promise of arbitrary branch-sensitive union handling. The accepted control and five negative assertions are independently checked in `union-controls.mts`, while the relevant negative boundaries also have their own unsuppressed compiler runs.

## Positive and package verification

`positive.mts` passes strict compilation and runtime assertions for matching same-key continuation declarations through handle/handler/intercept, continuation handlers inside and outside the operation handler, nested continuations, pure-to-effectful annotations, independent key extension, raw-key pure answers across mixed continuation contracts, disjoint-union pure continuations, optional rows, compatible common union keys, and inferred generic `C`. Type equalities verify both generic parameter orders and the preserved inferred continuation.

The existing independent `valid.mts` also passes fresh strict compilation and runtime execution: fixed effects, pure/independent rows, Sync, Async, Var, Resource acquisition/release, and all filesystem operation result types through Memory and Node. Its temporary Node files are cleaned in `finally`. An initial extra positive experiment placed a forwarding interceptor outside an already handled source; its forwarded operation correctly reintroduces the source row and cannot run as pure. The final positive controls exercise the supported inner/outer handler arrangements.

Commands and results:

```text
pnpm --filter kyoot --filter @kyoot/platform typecheck
  PASS, including all maintained compile fixtures
pnpm --filter kyoot --filter @kyoot/platform test
  PASS: core 204/204; platform 36/36
strict tsc positive.mts /tmp/kyoot-contract-final-probes/valid.mts
  PASS
node positive.mts
  PASS
node /tmp/kyoot-contract-final-probes/valid.mts
  PASS
strict tsc union-controls.mts; node union-controls.mts
  PASS; union requirement preserved, safe abort returns 27
```

Package logs are `/tmp/kyoot-contracts-final-astra-typecheck.log` and `/tmp/kyoot-contracts-final-astra-tests.log`. Positive compiler diagnostics are in `/tmp/kyoot-contracts-final-astra-positive-types.log`; the additional union compiler/runtime logs are in the probe directory. I did not rerun the other three workspace packages or claim their historical 307-test workspace run as fresh evidence.

## Comparison with older reviews

After this independent pass, I read `.audit/cleanup/contracts-review-sol.md` and `contracts-review-luna.md`. Both reviewed `800c86e` and excluded the then-separate filesystem repair. Their tested row/key/dependent boundaries remain supported by this fresh pass, but their earlier VERIFIED labels are not evidence that the missing continuation identity was checked: the later `dd35814` counterexample demonstrated that gap. This verdict adds direct verification of that gap's repair and the integrated filesystem boundary.

The older Luna statement that `unsafeMakeHandler` is not package-exported is historical and does not describe this revision. It is explicitly exported now, remains clearly named unsafe, and is outside this checked-contract verdict.

## Exact source identities

HEAD was `df093065096b7c2714eed0ccfabb71f9cca8cc23` at the initial and final checks. `git diff --exit-code HEAD -- packages/kyoot packages/platform` succeeds. Existing worktree differences are audit artifacts only. The 24 source files below were SHA-256 hashed and rechecked before writing this report; the separate manifest is `/tmp/kyoot-contracts-final-astra-source-hashes.txt`.

```text
de45d61acf2db85aa3f3873c5c46bf890a6d8f5ffe6bdc741a6c05d5d4f45339  packages/kyoot/src/core.ts
0308b91a72df3527c90e8d53ea785f184a412f32c149cccc18fd266e7b3bf35d  packages/kyoot/src/effects/async.ts
7656b1e0451d52c4681c331804ab5fb229ddd66db78daf0808686799cdfd9bb7  packages/kyoot/src/effects/clock.ts
ce37ab69a414cd181069f1ed5701ef187248b3bade3ee05869fedd49546bdaab  packages/kyoot/src/effects/emit.ts
08093aa37eb6968c6e208312b23d53d59724a047de6f8c43dbd201ec2d224f6e  packages/kyoot/src/effects/env.ts
43e4b54c0276f5d42fac183c52fb4cea2e793b228a7d72c828602d3a68ff09f3  packages/kyoot/src/effects/fail.ts
dbb0045aba181ccdbde2b19ec220f83f03c5e89c52892e0c31259ef4ecbe4744  packages/kyoot/src/effects/log.ts
8574fd8869d3ee248fcf3f4e9ad8fb17aa714559df9244ec4030cd6ae1059b49  packages/kyoot/src/effects/random.ts
2139498feda6e9bdc0f7f5a3b38fd30a75888f45700f7ece455a8e7f2d41c090  packages/kyoot/src/effects/resource.ts
d28b2dfdcd193d54c1216583bcdbaae10146d834460beb4223925abd22f05e11  packages/kyoot/src/effects/retry.ts
a431c357a637f0ef331ed4552f5433a86de8e4ff51ec9cf66f42dcf5e18d11f3  packages/kyoot/src/effects/sync.ts
50bbb5ee1a65f04396d974c57b051edf237dd121a9ad89f3c4b1292855c8ca3a  packages/kyoot/src/effects/var.ts
cfb5202ece06b5d051c9b96cbd8bc0774ee323a6dd51b798a2c1cb713c817868  packages/kyoot/src/index.ts
a5c161d27a68bc729c894cbf70e915d2cee7eb2fb95a4a49043ed26e46384eb7  packages/kyoot/src/machine.ts
f968f59551104e032d88116ad05ea25368e19a91e05107c02f299708e87baac9  packages/kyoot/src/model.ts
3f24236cf42acd3f0d455d4d8ae0a7f1a87358cb4cf28a3e570960d496d187c9  packages/kyoot/src/pipe.ts
735f51181c6e7d70133c049dcba5fbb452e9ebf2a42c3b265a413cb5353f53ef  packages/kyoot/src/result.ts
b91dca1cf610cfbe84aa10ae4a872e50eab852bc3e5bab18bbfbd4ccdfb2c5b6  packages/kyoot/src/runtime.ts
587ce1199614297f5f754321ca8da94bcda81456dd5c51ee36a5e6c6243115fd  packages/kyoot/src/types.ts
158370100abcb2ac70edf8120d3be84c895e6eacccf5a786bd87d423ba9679ef  packages/platform/src/command.ts
4f270c0376bc8fee45c66cac523c3bc02a8b3b02e0073e2d5d70cf1a81f40dcd  packages/platform/src/fs.ts
eecf5f7384e1b095767e5df764102cf03b955ee9931ec97e3d2430b114af5882  packages/platform/src/index.ts
da15e86da41df049111f768157d1b5ed7755fe402a6a66b43ac2c74a44c2fb64  packages/platform/src/memory.ts
9dbaaab1474d1220496ec2dd260186063ae29cfb2a2df3da7b9260a0dafad70d  packages/platform/src/node.ts
```
