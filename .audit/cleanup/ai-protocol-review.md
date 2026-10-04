# AI protocol cleanup verdict: A5 / A6 / A7

**VERIFIED for the local protocol boundary at the exact source snapshot below.** The package tests and typecheck pass. Independent local `Response` streams reproduce and pass the two earlier review blockers: early malformed output releases an open source stream, and malformed chunk containers/content produce typed `ProviderError(422)` failures. The same probe confirms valid nullable fields, usage, fragmented text, and out-of-order tool-call assembly.

## Exact target

- Checkout: `/Users/texoport/code/kyoot-protocol-cleanup`; branch `cleanup/ai-protocol`.
- Base `cleanup/registry`: `51f661956d3f481cfd836219345fbe86f1063f22`.
- HEAD: `5b87639d55fb962f165a7e9a268402c668d97d5e`, plus uncommitted AI source/test edits.
- SHA-256 of `git diff --binary cleanup/registry -- packages/ai/src packages/ai/test`: `44b5c58a743d6e03aea10463aaea73d42229e5d05ec3a23c61f6c4a4b4e40c39`.
- Source/test SHA-256: `providers.ts` `aa8f9c9b14301f58a3d71b65b7eb2abc86fcbd83681049452b407e4cec8d28f8`; `sse.ts` `bf610fd159be36ac00bd2ef08f0eb8f73047806415dca2b94f05d9191f20f6de`; `generate.ts` `7037705c4cfa5d119bc345d8ddd0b06c60f91b2229b4d28fae0c06c3fd667006`; `providers.test.ts` `76f9ebc564f4eeeea2f61e45b69bffda79edd0b557319163ffe4834625421a35`; `ai.test.ts` `d632c742d9c62909e6bf57b996df80de4c2ba98d30f00d29b34ed1b2a46d21ef`.

## Evidence

- `pnpm --filter @kyoot/ai test`: 44 passed, 0 failed. This includes truncated streams, invalid and sparse call indices, fragmented calls, void tool receipts, reserved `answer` rejection, malformed chunks, stream cancellation, and pending-read interruption.
- `pnpm --filter @kyoot/ai typecheck`: passed. Focused `oxfmt --check`, `oxlint`, and `git diff --check cleanup/registry -- packages/ai/src packages/ai/test` passed.
- Earlier malformed-shape probe `/tmp/kyoot-protocol-adversarial-probe.mjs` (SHA-256 `65c88ffa239eb5aa5e807ab8b9f8dc2c99dc6ead11cf80dc4657ba09f63aac6d`) exits 0. Object `tool_calls`, null call member, and numeric `content` each return typed `ProviderError(422)`; no source lock remains. Numeric content emits no text event in the new independent probe.
- Independent probe `/tmp/kyoot-protocol-verdict-probe.mjs` (SHA-256 `352964cbc60b121b206739417c4355f41fcc20836a865ea85b733e835f6229ef`) exits 0. Open streams containing a negative call index, object `tool_calls`, or null call member return typed 422, call `cancel()` once, and unlock. Pending-read interruption also cancels once and unlocks. A truncated closed stream returns typed 422, and a missing body returns typed 502.
- The same independent probe accepts `content: null`, `tool_calls: null`, and `usage: null`, then records usage `{input:12,output:4}` from a later chunk. Another stream splits encoded bytes into seven-byte fragments, emits `A` and `é`, assembles index 1 before index 0 into sorted calls `first` and `other`, and records usage `{input:21,output:8}`.

## Review notes and limits

`isChunk` checks parsed unknown data before the provider reads its choices, content, calls, or usage. The provider holds the SSE iterator as a scoped resource, and the fetch signal reaches the decoding pipeline. The ordered `Map` assembly rejects gaps, conflicting IDs, duplicate IDs, and missing names without work proportional to a supplied index. The scoped diff adds no comments, suppression directives, or `any` casts. The existing CR/LF parser comment describes real parser state. No redundant trusted-path guards or new abstractions stood out in the final diff.

This verdict covers the local AI package and stubbed HTTP responses at the hashes above. It does not establish live provider compatibility or process restart behavior. No source files or commits were changed by this review.
