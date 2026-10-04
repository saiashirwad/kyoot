# Checked-contract independent verdict

**VERDICT: VERIFIED** for checkout `800c86e7bdf28b12d13a1bb54a8beacdbcf46eb5` (`/Users/texoport/code/kyoot-cleanup`). The previously reported checked-contract counterexamples are rejected, additional no-cast/no-any attacks are rejected by the compiler, and intended fixed-contract composition remains available. This verdict covers the checked core and named built-ins at this exact commit; it excludes the separately assigned FileSystem dependent-hole repair.

## Verification evidence

- Recompiled `/tmp/kyoot-astra-probe/{intersection,union,served-intersection,var}.ts` using strict TypeScript 7 flags. All four now fail compilation: row strengthening, served-row intersection, union dispatch key, and fixed handler over Var. The first three report incompatible phantom rows or `never` dispatch key. Var reports incompatible dependent/fixed contract rows through the piping boundary. No casts or `any` were added to these probes.
- Compiled `/tmp/kyoot-contracts-luna.ts` with strict mode, `noUncheckedIndexedAccess`, `skipLibCheck`, ES2022, NodeNext, and explicit Node types. Exit 0; all `@ts-expect-error` directives were consumed. Rejections included union, broad, never, open-template, numeric-template and branded-open keys; generic unknown-key constructors for effect/Env/Var/handler; a generic handler key; explicit generic override; continuation key collision through a union branch, broad string index, and template index; fixed handling of Sync/Async/Resource; and answer laundering into Emit.collect and Fail.run. Positive assignments covered pure-to-effectful annotations, independent row extension, compatible same-key declarations, and ordinary checked handling.
- `pnpm -F kyoot typecheck`: passed.
- `pnpm -F kyoot test`: 201 passed, 0 failed. This includes `contracts.test.ts` for same-contract declarations, actual undefined payload delivery, and fork-state behavior: `share` aliases by design; the copier runs separately for siblings and nested children and leaves parent state isolated.
- Existing `contract-repair.test-d.ts` and `contracts.test-d.ts` are included in the package typecheck. Their expected-error assertions exercise intersection/union strengthening, unknown/open rows, reserved key reuse, builtin dependent-family isolation, Emit/Fail contracts, and continuation overlaps.

The standalone strict probe found no acceptance hole. One experiment first placed `@ts-expect-error` on generic wrapper call sites; the compiler rejects these wrappers at their definitions because unknown `K` cannot satisfy `KeyArgument<K>`. The final probe places suppression at the definition and passes without unused directives. This is stricter ergonomically for generic key factories, but does not permit a bypass.

## Boundary and maintenance review

Checked exports use `makeHandler`; low-level implementation handlers are named `unsafeMakeHandler` and are not package-exported. Arbitrary continuation replacement is explicitly exposed with `unsafeIntercept`/`unsafeHandle` names in affected built-ins; Var uses `unsafeIntercept`. Runtime frame/snapshot handling remains erased and retains the interpreter's documented trusted boundary. The `@ts-expect-error` directives in the contract fixtures are required compile-time rejection tests; they are not implementation suppressions. The one source lint suppression in `core.ts` sits on the declaration merge needed to add `Pipeable` to `KyootImpl`.

## Scope and workspace state

I did not edit source files or commit. Before verification, `git status --short` showed only preexisting untracked `.audit/cleanup/contracts-integrated.log`. At the final check, `packages/ai/test/providers.test.ts` also appeared modified in the shared checkout; I did not inspect or alter it. This does not affect the kyoot core tests or source hashes below.

Source SHA-256 values at the verified commit:

- `packages/kyoot/src/model.ts`: `f968f59551104e032d88116ad05ea25368e19a91e05107c02f299708e87baac9`
- `packages/kyoot/src/core.ts`: `959ce21d75b0d686e34f791ec557fe8d552ff4bfd8e512ff4cec8d6d1aa85395`
- `packages/kyoot/src/types.ts`: `587ce1199614297f5f754321ca8da94bcda81456dd5c51ee36a5e6c6243115fd`
- `packages/kyoot/src/runtime.ts`: `b91dca1cf610cfbe84aa10ae4a872e50eab852bc3e5bab18bbfbd4ccdfb2c5b6`
- `packages/kyoot/src/machine.ts`: `a5c161d27a68bc729c894cbf70e915d2cee7eb2fb95a4a49043ed26e46384eb7`
- `packages/kyoot/src/effects/var.ts`: `50bbb5ee1a65f04396d974c57b051edf237dd121a9ad89f3c4b1292855c8ca3a`
- `packages/kyoot/src/effects/sync.ts`: `a431c357a637f0ef331ed4552f5433a86de8e4ff51ec9cf66f42dcf5e18d11f3`
- `packages/kyoot/src/effects/async.ts`: `0308b91a72df3527c90e8d53ea785f184a412f32c149cccc18fd266e7b3bf35d`
- `packages/kyoot/src/effects/resource.ts`: `2139498feda6e9bdc0f7f5a3b38fd30a75888f45700f7ece455a8e7f2d41c090`
- `packages/kyoot/src/effects/emit.ts`: `ce37ab69a414cd181069f1ed5701ef187248b3bade3ee05869fedd49546bdaab`
- `packages/kyoot/src/effects/fail.ts`: `43e4b54c0276f5d42fac183c52fb4cea2e793b228a7d72c828602d3a68ff09f3`
- `packages/kyoot/src/effects/env.ts`: `08093aa37eb6968c6e208312b23d53d59724a047de6f8c43dbd201ec2d224f6e`
- `packages/kyoot/src/effects/clock.ts`: `7656b1e0451d52c4681c331804ab5fb229ddd66db78daf0808686799cdfd9bb7`
- `packages/kyoot/src/effects/log.ts`: `dbb0045aba181ccdbde2b19ec220f83f03c5e89c52892e0c31259ef4ecbe4744`
- `packages/kyoot/test/contract-repair.test-d.ts`: `d7bcde1a055ac47044a8987d4e9d226e3274b0c20e03f24747f4408b2dc966f7`
- `packages/kyoot/test/contracts.test-d.ts`: `388b495268b847f4f89f458f6b3285d806d0b1b91f2ca8a98cb621468fcd6f81`
- `packages/kyoot/test/contracts.test.ts`: `e92735fae0fefaa3a573c2e5d83efed68a196a867a9d210dd667bcec204ed0ed`
