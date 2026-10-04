**VERIFIED within the checked public contract scope described below.**

The current continuation repair rejects the retained missing-contract, optional-key erasure, and optional/required union-branch narrowing failures. I found no new checked public API bypass in 27 fresh compiler probes. Matching required, optional, mapped, generic, nested, and union controls compile and execute correctly. The verdict covers strict TypeScript clients without explicit `any`, type assertions, suppressed errors in bypass probes, unsafe entry points, or direct internal runner use.

Reviewed checkout `/Users/texoport/code/kyoot-cleanup`, branch `cleanup/effect-contracts`, HEAD `df093065096b7c2714eed0ccfabb71f9cca8cc23`, plus the uncommitted continuation repair identified by the hashes below. The core and fixture hashes were checked before and after the verification. No repository files were edited, reverted, committed, or pushed by this reviewer. Temporary probes and this report are the only outputs.

throughput checkpoint: n/a, read-only investigation

The evidence supports three distinct parts of the repair. At `packages/kyoot/src/core.ts:103`, the private `RequirementShape<P, A, V, C, Keys>` retains both the continuation row and its independently instantiated key set. At `core.ts:114`, the public alias supplies `keyof C` without exposing an override for that fifth argument. This rejects treating an optional continuation contract as a plain declaration. At `core.ts:142`, `MergeAll<Required<C>>` makes every continuation key required and merges alternative contracts at each key before the row reaches the invariant entry witness in `packages/kyoot/src/model.ts:83`. A client consequently cannot select one continuation answer by annotating the whole performed row as one branch.

The two retained string-returned-as-number counterexamples now fail on their row annotation with TS2322. The diagnostic reports that the source `s` entry contains `Requirement<void, string> | Requirement<void, number>`, while the target requires only the string contract. Reproduced sources are `/tmp/kyoot-continuation-union-narrow.mts` and `/tmp/kyoot-continuation-required-union-narrow.mts`. Both diagnostics are retained in `/tmp/kyoot-normalized-final-original-types.log`. The same compiler invocation also rejects the original optional declaration mismatch, the minimal optional outer-row erasure, and its ordinary/generic/union/mapped variants. I inspected the diagnostic sites rather than treating any nonzero exit as sufficient evidence.

The earlier independent matrix was rerun against the current source. All 62 negative cases reject, preserving intersection narrowing, incompatible union entries, open-row erasure, singleton dispatch keys, continuation identity, nested continuation permissions, and fixed/dependent boundaries for Var, Sync, Async, Resource, and FileSystem. The FileSystem probes include checked declaration/raw-key replacements and fixed lookalikes passed to Memory.fs, Node.fs, and Node.provide. Two retained compiler controls pass. The third old positive file requires the conservative-union adjustment explained below. Per-case current diagnostics and structured results are in `/tmp/kyoot-normalized-final-matrix/`; the rerunnable driver is `/tmp/kyoot-normalized-final-matrix.py`.

The fresh matrix has 27 standalone negative sources with no type assertions, `any`, or suppressed errors. Every case rejects with TS2322 or TS2345 at the attempted conversion, handler call, continuation call, or runner boundary. The cases cover Pick/Partial/mapped annotations; optional and required unnormalized unions; explicit declaration/raw-handler generic arguments; interceptor, generator, and flatMap composition; return annotations and generic normalization; explicit runner erasure; intersection and outer-union narrowing; removing the top-level phantom witness by object rest; inferred generic pairs; explicit `resume.with` row arguments; a disjoint continuation hidden in a conditional expression; nested optional continuation loss; runPromise served-row intersection; Async.all laundering; fixed Var replacement; and narrowing the continuation declaration itself. Sources, complete diagnostics, and results are under `/tmp/kyoot-normalized-final/fresh/`. Reproduce them with `python3 /tmp/kyoot-normalized-final/probe-matrix.py`.

Matching runtime controls passed after strict compilation. `/tmp/kyoot-normalized-final/positive.mts` exercises required continuations through direct and piped handlers, interception, an inner installed handler, nested continuations, inferred generic C, independent row additions, pure computations with effect annotations, raw pure resumption of mixed declarations, optional continuations, and normalized union rows. `/tmp/kyoot-normalized-final/optional-positive.mts` checks ten optional paths, including mapped, union, nested, generator, and flatMap cases; each returns the expected 11. It also retains compile-time rejection assertions. The existing `/tmp/kyoot-contracts-final-astra-probes/union-controls.mts` preserves the complete conflicting answer union and safely aborts to 27. `/tmp/kyoot-contract-final-probes/valid.mts` executes fixed, dependent, continuation, pure, extra-row, and Memory/Node filesystem controls. All four files compiled together with exit 0 and ran with exit 0. Compiler output is retained in `/tmp/kyoot-normalized-final-positive-types.log`.

Union tracking is deliberately conservative. `C = S | T` now exposes both possible keys in the performed row, even when the handler resumes with a pure computation. A common-key union such as `S | (S & T)` also retains T. The old positive probe expected these extra keys to disappear. Its fresh rejection is recorded in `/tmp/kyoot-normalized-final-matrix/kyoot-contracts-final-astra-probes-positive.log`. The adapted controls install handlers for every normalized branch key and return the same expected values. `resume.with` still permits only keys common to the alternatives in C, because its allowed-key check uses `keyof C`. A disjoint-union declaration can use pure resumption; selecting a branch-specific effect remains rejected. This preserves the current API's conservative behavior while closing the row-narrowing hole.

Independent package checks completed successfully:

| Check                               | Observed result                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `pnpm -F kyoot typecheck`           | Passed, including the current optional and required union regression assertions. |
| `pnpm -F @kyoot/platform typecheck` | Passed, including FileSystem checked-boundary assertions.                        |
| `pnpm -F kyoot test`                | 205 passed, zero failed. `/tmp/kyoot-normalized-final-core-test.log`.            |
| `pnpm -F @kyoot/platform test`      | 36 passed, zero failed. `/tmp/kyoot-normalized-final-platform-test.log`.         |
| `git diff --check`                  | Passed.                                                                          |

The coordinator separately reports a passing full workspace check with 308 runtime tests. I did not repeat that workspace-wide run. This verdict's direct execution evidence is the focused package checks and independent probes above.

The standalone compiler used TypeScript 7.0.2 and Node v26.10.0. Reproduce an individual probe from the reviewed checkout with:

```sh
./node_modules/.bin/tsc --ignoreConfig --strict --noUncheckedIndexedAccess \
  --exactOptionalPropertyTypes false --noEmit --target es2022 \
  --module nodenext --moduleResolution nodenext \
  --allowImportingTsExtensions --skipLibCheck --types node \
  --typeRoots /Users/texoport/code/kyoot-cleanup/node_modules/@types \
  /tmp/kyoot-continuation-union-narrow.mts
```

Type System Discipline shaped the adversarial probes. They attempt ordinary public assignments and generic instantiations without bypassing the compiler. Prove It Works shaped the verdict. I compiled the historical failures against the actual source, inspected the resulting disagreements, ran matching runtime controls, and bound the result to exact artifact hashes.

Reviewed SHA-256 values:

```text
4e8233417a3d78bbd7bc50f6f588e4e8a992ea127aebe05ad0e71e824f63ef24  packages/kyoot/src/core.ts
f968f59551104e032d88116ad05ea25368e19a91e05107c02f299708e87baac9  packages/kyoot/src/model.ts
587ce1199614297f5f754321ca8da94bcda81456dd5c51ee36a5e6c6243115fd  packages/kyoot/src/types.ts
b91dca1cf610cfbe84aa10ae4a872e50eab852bc3e5bab18bbfbd4ccdfb2c5b6  packages/kyoot/src/runtime.ts
50bbb5ee1a65f04396d974c57b051edf237dd121a9ad89f3c4b1292855c8ca3a  packages/kyoot/src/effects/var.ts
4f270c0376bc8fee45c66cac523c3bc02a8b3b02e0073e2d5d70cf1a81f40dcd  packages/platform/src/fs.ts
119cee094ae61832a3e070d30028d26ef023abcd8012c60050955bb59e8a42b3  packages/kyoot/test/continuation-contract.test-d.ts
58f48272f7c64b8054d63a72dae44b90afadc2fe42a8b1a58913d10d0fff3e4a  packages/kyoot/test/contracts.test.ts
d7bcde1a055ac47044a8987d4e9d226e3274b0c20e03f24747f4408b2dc966f7  packages/kyoot/test/contract-repair.test-d.ts
daff72757227bfea28cab5c034c6da55e3eb969663e1164f922ed0b26bb94e6d  packages/platform/test/fs.test-d.ts
```
