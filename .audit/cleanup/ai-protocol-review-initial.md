# AI protocol review: A5 / A6 / A7

**Verdict: NOT VERIFIED** for the combined protocol change because an early validation failure leaves a live provider response stream locked and uncancelled. The functional checks below pass. This verdict is confined to the AI package and local stubbed streaming responses; no live provider credentials or full provider integration were exercised.

Review target: base `51f6619`, commit `5b87639d55fb962f165a7e9a268402c668d97d5e`, plus the current uncommitted `providers.ts` / `providers.test.ts` index and fragment fix. SHA-256 of `git diff --binary 51f6619` at review time: `b0b9ad9aa57c82586900533356b10c0465c88f21d36d41305390380a6de1f348`. SHA-256 of the package source/test diff alone: `e992dc3c28c86bb1cb0b2226b33b72eafea6cdc56e7f4ff1e68a4a643a9e5dd2`. The full diff hash excludes untracked audit logs and may change as other agents update audit files.

## Act on

- **Release the SSE iterator/body on early failure or interruption.** `complete` creates `events(res.body)` at `providers.ts:76`, then returns from inside the loop on an invalid index or fragment at lines 92-101. It never calls `it.return()` or cancels the body. A direct local probe supplied one invalid-index event and deliberately left the response stream open. `Kyoot.runPromise` returned `ProviderError(422, "Invalid tool call index")`, but the stream's `cancel()` callback count was `0` and `stream.locked` was `true` after completion. This can retain the HTTP connection and stream resources after malformed provider output. The same exit shape applies to other early failures; interruption was not independently exercised. Ensure cleanup on every exit from the iterator, then add a regression test with a nonclosed stream and cancel callback.

## Verified local behavior

- `pnpm --filter @kyoot/ai test`: 34/34 passed. `pnpm --filter @kyoot/ai typecheck`: passed. A pnpm bin-link warning for `oxlint` appeared during installation; it did not affect these commands.
- The package tests cover terminal `[DONE]` acceptance, refusal of a truncated stream, absent IDs/names, negative/sparse/oversized indices, conflicting IDs, duplicate assembled IDs, nonstring fragments, split tool-call assembly, a void tool's string receipt (`"null"`), and structured-output `answer` name rejection before a tool executes.
- Direct stubbed `chatCompletions` probes also observed: `Response(null)` returns `ProviderError(502, "Missing response body")`; an out-of-order two-index call stream completes; a negative index returns `ProviderError(422)`; a first empty ID repaired by a later ID fragment completes. The last case is consistent with final-assembly validation.

## Boundary note

A `tool_calls` object in place of an array, or a `null` member inside the array, produces a Kyoot `Defect` rather than a typed `ProviderError` in direct probes. Neither case was accepted or executed as a tool. This is a malformed-input error-shape gap at the provider boundary, but a full upstream schema rewrite is outside this review's scope. It does not alter the resource-leak finding.

## Review judgement

The Map and final-assembly checks address sparse indices and duplicate IDs without building a sparse array. The extra boundary checks are proportionate to untrusted streamed fragments. No code changes were made in this review. Tests and local stubs do not establish live OpenAI/DeepSeek compatibility or all interruption behavior.
