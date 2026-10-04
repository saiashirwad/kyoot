# Independent checked-contract final verification

**Overall verdict: NOT VERIFIED.** Checked declaration handlers still accept incompatible continuation rows and can return `undefined` where the supported checked API promises `number`. This is independent of explicit unsafe APIs, assertions, `any`, or direct internal imports.

**FileSystem fixed/dependent separation: VERIFIED within the bounded checks below.** The fresh FileSystem repair rejects fixed replacements through declaration handlers, checked raw-key handlers, and built-in interpreter entry points. The five retained pre-repair filesystem paths now fail strict compilation. This filesystem result does not supersede the overall checked-contract blocker.

Reviewed revision: `dd358140e031d5d420041b70440c635bcc360cc7` in `/Users/texoport/code/kyoot-cleanup`. HEAD was checked before and after the validation pass. No source edits or commits were made. Existing modified/untracked files were audit artifacts only. Source hashes are recorded below and in `/tmp/kyoot-contract-final-source-hashes.txt`.

## P1: Declaration handlers do not preserve continuation contracts

Locations: `packages/kyoot/src/core.ts:103` (`Requirement`), `:214` (performed row), `:224` (`handle` constraint), and `:228` (`handler` constraint).

A fixed requirement records payload, value, and answer, but does not record continuation row `C`. Both declaration handler forms constrain only the performed entry's `Requirement<P, A, V>`. The handler callback nevertheless receives `Resume<A, St, C>`, whose `with` method treats the effects in that declaration's `C` as already available. Its result has an empty row, so those effects do not appear among the callback's output requirements.

Two declarations can consequently agree about key, payload, answer, and value while disagreeing about continuation effects. The stronger counterexample is:

```ts
const NumberContinuation = effect<void, number, EffectRow<"s", void, number>>()("n");
const StringContinuation = effect<void, number, EffectRow<"s", void, string>>()("n");
const Text = effect<void, string>()("s");
const NumberS = effect<void, number>()("s");

const typedNumber: number = Kyoot.runSync(
  NumberContinuation(undefined).pipe(
    StringContinuation.handle({
      onOp: (_, resume) => resume.with(Text(undefined).map((text) => text.length)),
    }),
    NumberS.handle({ onOp: (_, resume) => resume(7) }),
  ),
);
```

Strict TypeScript 7.0.2 compiles this without diagnostics. At runtime the `s` handler resumes the string continuation with `7`, `text.length` becomes `undefined`, and the supposedly numeric result is `undefined`.

A second variant applies a declaration with `C = { s: Requirement<void, number> }` to a same-key operation declared with `C = {}`. The final program assigns to `Kyoot<number, {}>`, but `runSync` throws `runSync encountered unhandled effect 's'`. This proves lost effect tracking separately from wrong-answer delivery.

The direct `StringContinuation.handler(program, hooks)` form has the same wrong-answer behavior; it is not limited to pipe inference.

Retained executable probes:

- `/tmp/kyoot-contract-final-probes/continuation.mts`: both wrong-answer and unhandled-effect variants.
- `/tmp/kyoot-contract-final-probes/continuation-handler.mts`: direct declaration handler variant.
- `/tmp/kyoot-contract-final-continuation-typecheck.log`: compiler exit 0, no diagnostics.
- `/tmp/kyoot-contract-final-continuation-runtime.log`: assertion-backed runtime confirmation, exit 0.
- `/tmp/kyoot-contract-final-continuation-handler-typecheck.log`: compiler exit 0, no diagnostics.
- `/tmp/kyoot-contract-final-continuation-handler-runtime.log`: assertion-backed runtime confirmation, exit 0.

Root direction: carry the declaration's continuation contract through the checked requirement/handler relationship, or make every newly introduced continuation requirement explicit in the output row. Merely rejecting the performed key inside `C` does not address two declarations disagreeing about a different continuation key. Cover both handler forms, absent continuation entries, and incompatible continuation entries. Retain the existing valid `resume.with` control and cases where a continuation effect is handled inside the resumed program.

## Verification performed

Runtime and package compiler checks:

| Check                               | Result                                                      | Evidence                                                                                       |
| ----------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm -F kyoot typecheck`           | Passed                                                      | `/tmp/kyoot-contract-final-core-typecheck.log`                                                 |
| `pnpm -F @kyoot/platform typecheck` | Passed                                                      | `/tmp/kyoot-contract-final-platform-typecheck.log`                                             |
| `pnpm -F kyoot test`                | 201 passed, zero failed                                     | `/tmp/kyoot-contract-final-core-test.log`                                                      |
| `pnpm -F @kyoot/platform test`      | 36 passed, zero failed                                      | `/tmp/kyoot-contract-final-platform-test.log`                                                  |
| Retained filesystem repro           | Compiler exit 1, all five unsafe former paths rejected      | `/tmp/kyoot-contract-final-fs-repro.log`                                                       |
| Four retained Astra probes          | Compiler exit 1; all four rejected at the intended boundary | `/tmp/kyoot-contract-final-original-repros.log`                                                |
| Independent negative matrix         | All 18 cases rejected                                       | `/tmp/kyoot-contract-final-probes/negative-matrix.json`                                        |
| Independent valid controls          | Strict compiler and runtime both exit 0                     | `/tmp/kyoot-contract-final-valid-typecheck.log`, `/tmp/kyoot-contract-final-valid-runtime.log` |
| `git diff --check HEAD`             | Passed                                                      | Ran against the final reviewed checkout                                                        |

The 18 independent negative cases contain no casts, `any`, unsafe APIs, or suppressed diagnostics. Each has a retained `.mts` source and compiler log under `/tmp/kyoot-contract-final-probes/`:

- Number/string same-key assignment, intersection laundering, union-row laundering, and open-row erasure.
- Union effect identity, union raw-handler identity, broad Env identity, and broad Var identity.
- A continuation row redefining its performed key.
- Fixed declaration replacements of dependent Var, Sync, Async, Resource, and FileSystem operations.
- Checked raw-key replacement of a FileSystem operation.
- Fixed FileSystem lookalikes passed to `Memory.fs`, `Node.fs`, and `Node.provide`.

The maintained core fixtures also reject open templates, branded open strings, never constructor identities, explicit generic union identities, incompatible fixed payloads/answers, fixed Emit/Fail lookalikes, dependent raw-key replacement, and callbacks requiring absent error fields. Their assertions remained active during the package typecheck.

The independent valid controls exercise pure-to-effectful annotation, addition of an independent requirement, matching declaration continuations through `resume.with`, ordinary Sync/Async/Var/Resource interpretation, and filesystem read/write/append/readDir/stat/exists/mkdir/rename/remove operations through Memory and Node. These controls contain no casts, `any`, unsafe calls, or suppressed diagnostics. Temporary Node filesystem data was removed in `finally`.

Undefined payload delivery passed the dedicated checked-handler runtime test, and the maintained type tests preserve `undefined` in payload extraction. Fork state tests passed for sibling/nested copier calls, parent isolation, deliberate shared mutable references, and fresh child scope creation. Source inspection of `inherit` confirms the copier runs for each inherited snapshot and preserves the intended scope hook behavior.

## FileSystem and code-quality assessment

The new private dependent family marker closes the repaired FileSystem paths: the row is no longer structurally a fixed unknown-answer requirement. Both interpreter signatures require the dependent row, and the ordinary public `handle`, `handler`, and `intercept` aliases are removed. Explicit `unsafeHandle`, `unsafeHandler`, `unsafeIntercept`, `unsafeMakeHandler`, `unsafeMakeIntercept`, and `unsafeOp` remain deliberate trusted boundaries and are not findings.

The fresh filesystem implementation diff is small and coherent: one dependent family, a private operation constructor retaining its discriminant-to-answer mapping, and explicit unsafe replacement APIs. There are no new runtime guards, compatibility aliases, duplicated nominal marker shapes, or source comments that obscure executable constraints. The new negative type-test comments are executable compiler assertions and should remain. The private assertion bridging the operation constructor to its dependent row is expected trusted implementation code. I found no separate deletion/deslop action in this diff.

The core repair's entry invariance and singleton-key checks close the earlier intersection, union-key, and fixed/dependent crossings. The remaining continuation hole is a missing piece of the checked relationship, not a request to remove the declared unsafe boundaries or redesign the runtime.

Persistence, process recovery, and unrelated platform behavior were outside this pass. The filesystem verdict is specifically bounded to the repaired answer-contract separation and the valid controls above; this is not a claim of whole-library soundness.

## Reproduction command

From `/Users/texoport/code/kyoot-cleanup`:

```sh
./node_modules/.bin/tsc --ignoreConfig --strict --noUncheckedIndexedAccess \
  --target es2022 --module nodenext --moduleResolution nodenext --types node \
  --typeRoots /Users/texoport/code/kyoot-cleanup/node_modules/@types \
  --noEmit --allowImportingTsExtensions --skipLibCheck \
  /tmp/kyoot-contract-final-probes/continuation.mts \
  /tmp/kyoot-contract-final-probes/continuation-handler.mts
node /tmp/kyoot-contract-final-probes/continuation.mts
node /tmp/kyoot-contract-final-probes/continuation-handler.mts
```

Compiler: TypeScript 7.0.2. Runtime: Node v26.10.0.

## SHA-256 source identities

```text
959ce21d75b0d686e34f791ec557fe8d552ff4bfd8e512ff4cec8d6d1aa85395  packages/kyoot/src/core.ts
f968f59551104e032d88116ad05ea25368e19a91e05107c02f299708e87baac9  packages/kyoot/src/model.ts
cfb5202ece06b5d051c9b96cbd8bc0774ee323a6dd51b798a2c1cb713c817868  packages/kyoot/src/index.ts
b91dca1cf610cfbe84aa10ae4a872e50eab852bc3e5bab18bbfbd4ccdfb2c5b6  packages/kyoot/src/runtime.ts
a5c161d27a68bc729c894cbf70e915d2cee7eb2fb95a4a49043ed26e46384eb7  packages/kyoot/src/machine.ts
a431c357a637f0ef331ed4552f5433a86de8e4ff51ec9cf66f42dcf5e18d11f3  packages/kyoot/src/effects/sync.ts
0308b91a72df3527c90e8d53ea785f184a412f32c149cccc18fd266e7b3bf35d  packages/kyoot/src/effects/async.ts
50bbb5ee1a65f04396d974c57b051edf237dd121a9ad89f3c4b1292855c8ca3a  packages/kyoot/src/effects/var.ts
2139498feda6e9bdc0f7f5a3b38fd30a75888f45700f7ece455a8e7f2d41c090  packages/kyoot/src/effects/resource.ts
4f270c0376bc8fee45c66cac523c3bc02a8b3b02e0073e2d5d70cf1a81f40dcd  packages/platform/src/fs.ts
da15e86da41df049111f768157d1b5ed7755fe402a6a66b43ac2c74a44c2fb64  packages/platform/src/memory.ts
1f7011abda88024a2fb52e2e09457022a8f422fda792d10027f50964b3c3f8df  packages/platform/src/node.ts
```
