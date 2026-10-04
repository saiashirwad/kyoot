# Final AI protocol review: A5 / A6 / A7

**Verdict: NOT VERIFIED.** The original A5/A6/A7 regressions and the prior stream leak now pass, but nearby malformed provider chunks still cross the same boundary incorrectly. An object `tool_calls` container or a `null` call member becomes a Kyoot `Defect` instead of a typed `ProviderError`. A numeric `content` field is accepted as a successful completion (`text: "42"`) and is emitted as a numeric text event. These are concrete local counterexamples to the provider's declared chunk and event shapes. The malformed streams do release the source lock, so the stream ownership repair itself is effective.

## Exact target

Checkout: `/Users/texoport/code/kyoot-protocol-cleanup`, branch `cleanup/ai-protocol`; base `cleanup/registry` at `51f661956d3f481cfd836219345fbe86f1063f22`; HEAD `5b87639d55fb962f165a7e9a268402c668d97d5e` plus the uncommitted AI source/test changes. SHA-256 of `git diff --binary cleanup/registry -- packages/ai/src packages/ai/test`: `d2d379a46e16f73ea0423a4d64d9622382531f36961a1cb4387d548b3be3fa78`. This excludes changing audit files and untracked files.

Source/test SHA-256 at review time:

- `packages/ai/src/providers.ts`: `370ec209ec05de0d63333dbe5926ce9ab9eeb73d3c17ef6eefe2679dc696eb5`
- `packages/ai/src/sse.ts`: `bf610fd159be36ac00bd2ef08f0eb8f73047806415dca2b94f05d9191f20f6de`
- `packages/ai/src/generate.ts`: `7037705c4cfa5d119bc345d8ddd0b06c60f91b2229b4d28fae0c06c3fd667006`
- `packages/ai/test/providers.test.ts`: `732039201c8f46c167ce615249423c32e0628568de775c043017306b9f637cd8`
- `packages/ai/test/ai.test.ts`: `d632c742d9c62909e6bf57b996df80de4c2ba98d30f00d29b34ed1b2a46d21ef`

## Reproduced blocker

Retained probe: `/tmp/kyoot-protocol-adversarial-probe.mjs` (SHA-256 `65c88ffa239eb5aa5e807ab8b9f8dc2c99dc6ead11cf80dc4657ba09f63aac6d`). Run `node /tmp/kyoot-protocol-adversarial-probe.mjs`; it exits 1 until the three expected typed-error checks pass. It uses local `Response`/`ReadableStream` stubs and disables retry. Current output:

- `tool_calls: { index: 0 }`: result `{ok:false, cause:{_tag:"Defect"}}`; source cancelled once and unlocked. `providers.ts:96` iterates an unvalidated container.
- `tool_calls: [null]`: same Defect, cancelled once and unlocked. `providers.ts:97` reads `tc.index` without validating the member.
- `content: 42` followed by `[DONE]`: result `{ok:true, value:{text:"42", toolCalls:[], usage:{input:0, output:0}}}`. `providers.ts:92-94` treats truthy content as text and emits it without a type check.

These values come from parsed network JSON, so the `Chunk` TypeScript interface does not validate them. A focused runtime check of the content and call container/member shapes at `providers.ts:91-97` would close these cases without changing the parser's ownership model. Also check the emitted event value when fixing numeric content.

## Behavior that passed

- `pnpm --filter @kyoot/ai test`: 36/36 passed, including terminal marker acceptance, truncated stream rejection, split call assembly, missing/duplicate/conflicting IDs, sparse/oversized/negative indices, nonstring fragments, void tool string receipt `"null"`, reserved `answer` name rejection before tool execution, early malformed-stream cancellation, and pending-read interruption. `pnpm --filter @kyoot/ai typecheck` passed.
- Focused `oxfmt --check` and `oxlint` on the five changed AI source/test files passed; `git diff --check cleanup/registry -- packages/ai/src packages/ai/test` passed. A pnpm bin-link warning appeared during typecheck setup, but did not affect the command.
- Separate direct stub probes confirmed an open stream with a negative call index returns `ProviderError(422)`, calls `cancel()` once, and releases the lock; interrupting an empty open stream during a pending read rejects with `InterruptedError`, calls `cancel()` once, and releases the lock. A valid stream with index 1 before index 0 completes with calls ordered 0, 1. Sparse IDs, duplicate IDs, and a nonstring name fragment return typed `ProviderError(422)`.
- The `Resource.run` scope at `providers.ts:131` closes the SSE iterator; the captured fetch signal passed into `pipeThrough` at `sse.ts:9` settles an interrupted read. A5's original early-exit leak is repaired for the probed cases. A6 and A7 behavior is covered by direct package tests.

No added source comments or TypeScript/lint suppressions appeared in the scoped diff. The existing SSE comment about CR/LF handling documents a non-obvious parser state and matches the implementation. No source files were changed by this review. This is a local protocol review; live provider compatibility and process restart behavior were not exercised.
