# AI turn repair

The independent review at `f479135` found three failures in the selected in-memory turn contract. A structured answer skipped later tool calls while publishing their assistant entries. Accepted completions still referenced provider-owned arrays and calls. Failed convenience turns could retain conversation ownership without exposing a discard operation.

## Decisions

Structured output keeps the first valid answer and processes every call in its completion in order. The answer is a pending value in the calls state until all calls have receipts. A wrapper distinguishes an accepted `undefined` answer from the absence of an answer. Later valid answers receive `ignored: answer already provided`; invalid answers keep validation-error receipts. Denied tools and typed tool failures also get receipts, and the turn can then return its answer. Approval and notification failures preserve the pending answer across retry. A later unknown tool outcome prevents completion and publication, including on replay.

Rejecting a mixed completion would prevent otherwise permitted tools from executing. Returning at the first answer produced incomplete transcripts. Choosing the last answer would change the previous first-answer behavior and make later redundant calls overwrite an already accepted value. The chosen behavior preserves call order, approval, all known receipts, and the first valid answer.

Generation copies and freezes a completion when accepting the model result, before notifications or tool execution. Calls and usage are copied and frozen too. The retained assistant message uses the copied calls. Event consumers therefore receive frozen call values, and later provider mutations cannot change the transcript or remaining action sequence. Freezing only the original object would mutate provider-owned values; copying only when publishing history would leave retry state exposed.

`AI.discard()` delegates to the current owner's discard callback. The callback itself identifies the turn, replacing the separate symbol. This uses the same running guard and terminal discarded state as `Turn.discard()`. It releases failed convenience turns, invalidates their retained computations, leaves completed history intact, and does nothing without an unfinished owner. An active turn still throws `TurnBusy`. Automatically releasing a failed turn would allow a new conversation turn to proceed while the old retained computation could still replay, so explicit discard remains required.

`Turn.discard()` remains available for a specific turn, including before its first execution. The convenience method addresses the current conversation owner only. Discarding never undoes external tool actions and never publishes a partial transcript.

## Evidence

The retained regression file is `packages/ai/test/turn-repair.test.ts`. `ai-turn-repair-red.log` records its initial 12 cases at the review baseline: 11 failed and the existing write-before-answer case passed. The failures reproduce skipped actions and approvals, missing receipts, an incorrectly published answer before an unknown outcome, provider-owned transcript mutation, mutable event calls, and the missing convenience discard method. Two additional cases cover an `undefined` answer and provider mutation while a call notification has interrupted the pending sequence.

`ai-turn-repair-green.log` records the final focused suite. Package tests pass 55 cases, and the AI typecheck passes. `ai-turn-repair-check.log` records the workspace formatting, lint, typecheck, and test run. No provider or core implementation changed.

The deslop pass checked the focused production diff for comments, defensive wrappers, new casts, and redundant state. The answer cast already existed at the synthetic answer boundary; this repair moves it into the pending answer record. The conversation owner now holds the existing discard operation instead of adding another ownership registry. There are no new code comments or suppressions. The coordinator will run the independent no-comments review with the final turn review.

These tests use local model handlers and real turn/tool execution. They do not establish live provider behavior or process recovery. All retained state is in memory; durable IDs, persistence, and reconciliation after a process crash remain separate work.

A fresh independent review verified the turn contract and found a diagnostic inconsistency when a successful result's encoder throws. The first execution surfaced a raw defect even though the retained outcome was already unknown. ai-encoding-red.log records a failing immediate UnknownToolOutcome assertion. Encoding now executes inside the existing tool outcome boundary, so both first execution and replay report the retained unknown outcome and original cause without executing the action twice.
