# Independent A1 turn verdict

**VERIFIED for the selected in-memory A1 turn contract** at `086947dd942b5aa6b6d5d4a2f49c3a5ee6a51c62` (`cleanup/ai-turns`). The three findings from the earlier `f479135` review are closed. This review made no source edits or commits.

## Evidence

- Re-ran the earlier four-scenario independent probe against this worktree, then added assertions for convenience discard, multiple actions followed by model failure, and a result-encoding defect. Script: `/tmp/kyoot-turn-verdict-probe.mjs`; `node /tmp/kyoot-turn-verdict-probe.mjs` passed. A successful external action followed by model failure and whole-turn Retry produced one write, three model requests, and one prompt/tool receipt in committed history. Two tool actions followed by the same failure each executed once and produced exactly two ordered receipts.
- A completion with `answer` followed by `write` returned the first answer, executed the write, and published both receipts. Source and passing retained regressions also cover calls preceding the answer, invalid and later answers, typed tool failure, denial, an accepted `undefined` answer, pending approval/result-notification failures, and an unknown later action withholding publication.
- Mutating a provider-owned completion after the first action no longer changes the retained assistant call or receipt; both kept the original call ID. `snapshotCompletion` copies and freezes the completion, call list/calls, and usage before emitting call notifications or executing actions. History getters return fresh frozen message snapshots.
- A thrown tool defect produced `UnknownToolOutcome`; re-running the same computation did not execute the action again. `AI.discard()` released the failed convenience turn, made its old computation return `TurnDiscarded`, and allowed the next turn. Source and passing regressions establish the same running guard for `Turn.discard()` and `AI.discard()`, unknown interruption handling, fail-fast concurrent turn ownership, and direct `generate` replay.
- `pnpm --filter @kyoot/ai test` passed 71/71; `pnpm --filter @kyoot/ai typecheck` passed; `CI=true pnpm check` passed formatting, lint, all workspace typechecks, and all workspace tests. `git diff --check` passed.

## Narrow limit

If a successful tool returns an object whose `toJSON()` throws, the first run reports a raw `Defect`, while the retained turn becomes unknown. A retry reports `UnknownToolOutcome`; the action is not replayed. The no-autoplay contract holds, but the first error lacks the discard guidance carried by `UnknownToolOutcome`. This is a diagnostic inconsistency, not a verified duplicate-action path.

The manual no-comments/deslop inspection of the focused turn implementation found no new comments, suppressions, or `as any` casts. The `as never` at the generation effect boundary existed before this branch. There is no live-provider or process-restart recovery claim. Streaming text can repeat after a model retry, and call/result notification delivery is at most one attempt, as documented.

The working tree at review end had only the pre-existing mechanical `packages/ai/test/providers.test.ts` annotation and untracked `.audit/cleanup/ai-turn-integrated.log`; this review changed neither. Exact source SHA-256 values:

| File                                   | SHA-256                                                            |
| -------------------------------------- | ------------------------------------------------------------------ |
| `packages/ai/src/ai.ts`                | `68a9ca28d05a05c10f99fc92aea3998a928b5fe3a5e52eb1a5fd649ea669d534` |
| `packages/ai/src/generate.ts`          | `0e31470fe9406f8469cf41d1551a8664edc4981ef2e598ed6c075ade0497f8ab` |
| `packages/ai/src/tool.ts`              | `0a4e1b7169e85ba20fc86d6559852076b88a4d3e110d2349825d1a51997d86a5` |
| `packages/ai/src/turn.ts`              | `e1018430e9d0d458bf6906eb8c3400ceeebbb6eac89b3b3638b2d2b3d8586611` |
| `packages/ai/test/turn.test.ts`        | `556c2db3e69a5d9e4ed494469a52bd4ef7a326fd7897f605972cd1f72ade3724` |
| `packages/ai/test/turn-repair.test.ts` | `f680e97dd5d2c9f8e0038918b70ab15e499196ed88dd8614f621a58832244fa3` |
