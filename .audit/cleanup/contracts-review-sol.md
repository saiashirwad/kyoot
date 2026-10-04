# Independent checked-contract verdict

**VERIFIED for the supported checked core API at commit `800c86e7bdf28b12d13a1bb54a8beacdbcf46eb5`.** I inspected the repair source and diff independently. This verdict covers ordinary strict TypeScript without `any`, assertions, the explicitly named `unsafe*` APIs, direct internal imports, or `runFiber`. It does not certify arbitrary TypeScript programs or the separate known FileSystem dependent-contract hole under repair elsewhere.

The review used `/Users/texoport/code/kyoot-cleanup` without changing repository source or creating a commit. At the final check, HEAD was `800c86e`; the worktree had another worker's modified `packages/ai/test/providers.test.ts` and untracked `.audit/cleanup/contracts-integrated.log`, neither used for this verdict.

## Evidence

- Recompiled all five original Astra probes, including the two intersection programs, two union programs, and Var replacement. Strict TS7 rejected each at its intended boundary. The originals are `/tmp/kyoot-astra-probe/{intersection,union,probe,served-intersection,var}.ts` and the prior adverse report is `/tmp/kyoot-contracts-review-astra.md`.
- Built a separate no-cast/no-any strict compile probe at `/tmp/kyoot-contracts-sol-probe.ts` (SHA-256 `732f8c5d1056a0fa5c9a18cacfc20aa92ea6230541281788e134692ca6756e07`). Its `@ts-expect-error` checks reject same-key intersection and union strengthening, unknown/never/index/union row laundering, conflicting branch merging through `flatMap` and `Async.all`, union/wide/never/template/branded keys, generic key inference, overlapping continuation rows, wrong declaration/interceptor/raw handler answers, fixed/dependent Var/Sync/Async/Resource crossing, and Emit/Fail answer laundering. It also compiles independent-key annotations and composition through a continuation. The command exited 0 with no unused expected-error directives.
- Built and ran `/tmp/kyoot-astra-probe/sol-runtime.ts` (SHA-256 `b4c48392bddc40467f4e29a6e03c49007d9ebbd7178bef9889c141075f437f48`). It confirmed compatible same-key declarations return the typed answer; generic checked handlers receive a real `undefined` payload; independent continuation requirements execute; Emit collects `undefined`; Fail records an `undefined` typed error; Var and Env built-ins execute; a copier creates four child/nested copies with the parent state unchanged by children; `fork: 'share'` aliases the parent state. It passed strict typecheck and `node` execution.
- `CI=true pnpm -F kyoot typecheck` passed, including the maintained compile fixtures. `CI=true pnpm -F kyoot test` passed 201/201. `git diff --check 2d62944..HEAD -- packages/kyoot` passed. The typecheck fixture has 41 expected-error directives in `contract-repair.test-d.ts` and 14 in `contracts.test-d.ts`; TypeScript reports unused directives, so the successful typecheck confirms they each still test a rejection.

The tested compiler invocation used `./node_modules/.bin/tsc --ignoreConfig --noEmit --strict --noUncheckedIndexedAccess --skipLibCheck --allowImportingTsExtensions --target es2022 --module nodenext --types node --typeRoots /Users/texoport/code/kyoot-cleanup/node_modules/@types <probe>` from the worktree root. The original probes used one invocation with all five files. The new compile probe and runtime probe each used this invocation separately.

## Source reasoning and boundary review

`Kyoot`'s phantom witness is invariant per present row entry, while the surrounding parameter remains contravariant, so adding an unrelated key works. A fixed `Requirement` has an invariant payload/value/answer marker. A dependent requirement carries a disjoint discriminant and private family symbol. `effect`, Env/Var tags, and checked `makeHandler` require one statically known key; continuation keys are compared against `keyof MergeAll<C>`, including union branches. Checked raw handlers only accept fixed requirements and derive payload and answer from the private marker. Built-in Sync, Async, Resource, and Var operations carry dependent markers. Emit and Fail carry fixed `void` and `never` answers respectively.

The public package entrypoint exposes `makeHandler` as checked and calls lower-level operations `unsafeOp` and `unsafeMakeIntercept`. Dependent replacement methods have explicit `unsafe` names. Internal code names `unsafeMakeHandler` at each trusted boundary. Existing core implementation contains casts and internal `any` erasure; this verdict is about the checked package API, not those internal escape hatches. The one `oxlint-disable-next-line` in `core.ts` precedes the existing intentional interface/class merge. The compile fixtures' `@ts-expect-error` directives are necessary executable negative checks, and no new general suppression was introduced in the repair.

## Source fingerprints

SHA-256 at verdict time:

```text
f968f59551104e032d88116ad05ea25368e19a91e05107c02f299708e87baac9  packages/kyoot/src/model.ts
959ce21d75b0d686e34f791ec557fe8d552ff4bfd8e512ff4cec8d6d1aa85395  packages/kyoot/src/core.ts
587ce1199614297f5f754321ca8da94bcda81456dd5c51ee36a5e6c6243115fd  packages/kyoot/src/types.ts
b91dca1cf610cfbe84aa10ae4a872e50eab852bc3e5bab18bbfbd4ccdfb2c5b6  packages/kyoot/src/runtime.ts
a5c161d27a68bc729c894cbf70e915d2cee7eb2fb95a4a49043ed26e46384eb7  packages/kyoot/src/machine.ts
a431c357a637f0ef331ed4552f5433a86de8e4ff51ec9cf66f42dcf5e18d11f3  packages/kyoot/src/effects/sync.ts
0308b91a72df3527c90e8d53ea785f184a412f32c149cccc18fd266e7b3bf35d  packages/kyoot/src/effects/async.ts
2139498feda6e9bdc0f7f5a3b38fd30a75888f45700f7ece455a8e7f2d41c090  packages/kyoot/src/effects/resource.ts
50bbb5ee1a65f04396d974c57b051edf237dd121a9ad89f3c4b1292855c8ca3a  packages/kyoot/src/effects/var.ts
43e4b54c0276f5d42fac183c52fb4cea2e793b228a7d72c828602d3a68ff09f3  packages/kyoot/src/effects/fail.ts
ce37ab69a414cd181069f1ed5701ef187248b3bade3ee05869fedd49546bdaab  packages/kyoot/src/effects/emit.ts
08093aa37eb6968c6e208312b23d53d59724a047de6f8c43dbd201ec2d224f6  packages/kyoot/src/effects/env.ts
d7bcde1a055ac47044a8987d4e9d226e3274b0c20e03f24747f4408b2dc966f7  packages/kyoot/test/contract-repair.test-d.ts
```
