# Independent AI turn review

Verdict: **NOT VERIFIED** at `f47913532d8ae6b88b8c53f103b3d9e2863b2bcd` (parent `3572d5d1ca874f2f735c07e615384e8d29869caf`). Three reproducible turn/transcript defects remain. This review did not modify the source worktree or commit.

Source SHA-256:

| File                            | SHA-256                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| `packages/ai/src/ai.ts`         | `0ad900c0f9543578f5541ab7683ac3049ac636707f3e78e2a604c5055198fca6` |
| `packages/ai/src/generate.ts`   | `0db09e3bf070d6dacb85eee8c49a78942b9e43eb174be864d81eb16bf6676dd3` |
| `packages/ai/src/tool.ts`       | `0a4e1b7169e85ba20fc86d6559852076b88a4d3e110d2349825d1a51997d86a5` |
| `packages/ai/src/turn.ts`       | `d881837ee11a45373cca786913d74e21ce90b88311001093ddbb5e71088878c9` |
| `packages/ai/test/turn.test.ts` | `556c2db3e69a5d9e4ed494469a52bd4ef7a326fd7897f605972cd1f72ade3724` |

Checks: `pnpm --filter @kyoot/ai test` passed 41/41 tests; `pnpm --filter @kyoot/ai typecheck` passed. `git status --short` was empty after checks. I also ran `/tmp/kyoot-turn-probe.mjs` with four separate observations; rerun from the worktree with `node /tmp/kyoot-turn-probe.mjs`.

## Findings

1. **Structured answer can publish an incomplete tool transcript.** `generate.ts:147-158` sets progress to `done` as soon as it processes the synthetic `answer` call. With one completion containing `answer-id` followed by `write-id`, the probe returned `ok`, executed zero writes, and published the assistant's two tool calls with only the `answer-id` receipt. Output: `mixed answer: answer=ok, writes=0, assistantCalls=answer-id,write-id, receipts=answer-id`. A subsequent conversation turn inherits this incomplete transcript. This early return existed before the cleanup, but it violates the selected completion/receipt contract and the review's transcript-shape criterion. Either reject such a completion before publication or define and implement complete handling for every call.

2. **A retained model completion remains mutable from outside the turn.** `generate.ts:97-107` stores the provider's `completion` object and places its `toolCalls` array directly in `added`. After one successful `write` receipt and a failure of the following model call, the probe mutated the original completion's call ID and reran the same turn. The next model request contained assistant call ID `mutated` beside tool receipt ID `original`, although the action ran once. Output: `completion mutation: final=done, writes=1, assistantId=mutated, receiptId=original`. The code snapshots input and published history, but the recorded model completion and in-flight transcript do not have that protection. Copy the completion and each call when accepting the model result; keep its recorded value private from event consumers too.

3. **`ask` and `gen` can strand a conversation after an unknown outcome.** `ai.ts:77-78` returns only `turn(...).run`, while `ai.ts:43,65-69` reserves ownership until `discard()`. The probe used `ai.ask('first')` with a tool that performed an action and then threw. Its result was `UnknownToolOutcome`; the next `ai.ask('second')` failed `TurnBusy`, and there is no public turn handle from the first call on which to invoke `discard()`. Output: `hidden turn: writes=1, first=UnknownToolOutcome, second=TurnBusy, history=0`. The existing convenience API needs a defined way to release a permanently failed turn, or its return value needs to expose turn control.

## Confirmed behavior and limits

The independent replay probe caused one successful write, then a transient failure on the next model request, then a retry. It produced one write, three model requests, and history roles `user,assistant,tool,assistant`; the failed and retried model requests were identical. The passing tests cover direct `generate` replay, notification failure, approval choice retention, unknown tool defects and interruption, concurrent same/distinct turns, running discard rejection, and explicit discard. Source inspection confirms receipts precede result notification (`generate.ts:147-158`), approval precedes the action and is kept in progress (`generate.ts:125-131`), and tool entry marks an unknown outcome before execution (`generate.ts:131-143`).

This is an in-memory review. I did not test live providers or process restart recovery. The checked worktree still contains old raw effect annotations; integrated core/compiler checks belong to the later mechanical migration.
