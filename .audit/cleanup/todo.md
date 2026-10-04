# Cleanup run

- [x] Read the Principles section of the **poteto-mode** skill.
- [x] Phase A: Frame
- [x] Phase B: Design the workflow
- [ ] Phase C: Run the loop
- [ ] Phase D: Keep the audit trail
- [ ] Phase E: Verify and hand back

## Autonomous run

- [x] 1. State the exit condition as a checkable predicate before the first iteration (tests green, repro fixed, all N PRs merged, pixel-diff zero).
- [x] 2. Pick the wake mechanism using Claude Code's `loop` skill (a built-in, not a pstack skill). An event to watch (CI, a merge, a ref advancing) gets a watcher subagent that wakes you on the event, with a long time-based heartbeat as fallback. No event gets a fixed-interval heartbeat sized to when the result is worth re-checking.
      skip: Codex has no loop tool. Agent completion events wake the coordinator. Poll external checks only after the complete stack exists.
- [ ] 3. Each iteration makes the smallest change the evidence justifies, verifies it against the predicate, commits if it advanced, discards changes that didn't help. Belt-and-suspenders that "might help" gets reverted, not left to ride.
- [ ] 4. Mid-run discoveries are yours. Address broken skills, related bugs, flaky verifiers, review noise, tooling failures, orphaned follow-ups, and fixable drift yourself via poteto-mode. Put out-of-band fixes in their own PR. Do not park reversible work for the human or use `AskUserQuestion`. Surface only irreversible actions, genuine product or preference calls no experiment can settle, or a real dead end. Keep the predicate as the main drive, and return to it after each side fix.
- [ ] 5. Checkpoint every iteration via the **show-me-your-work** skill, a row for what changed and whether the predicate moved.
- [ ] 6. Stop when the predicate is met. A plateau is not a stop, so keep going and pivot your approach to push past it. Surface a genuine dead end rather than spinning, and never relax the predicate to declare victory.

## Designed units

- [x] A3/A4. Reproduce runner unwind and typed-finalizer abort. Fix and independently verify resource cleanup.
- [x] A2/A9/A10. Reproduce command cancellation, output policy, and invalid rename. Fix and independently verify platform behavior.
- [x] A8. Reproduce interrupted registry setup. Fix and independently verify ownership and removal.
- [x] A5/A6/A7. Reproduce truncated streams, void results, and reserved name collision. Fix and independently verify protocol boundaries.
- [x] A11/A12/A13. Compare effect and fork contracts. Reproduce unsafety, implement selected model, independently verify compiler and runtime.
- [x] A1. Compare turn ownership designs. Reproduce repeated external action and concurrent history corruption. Implement and independently verify in-memory outcomes.
- [x] Deslop and no-comments review.
- [x] Check exact unit commits and integrated workspace checks.
- [ ] Push ready PR stack with parent base branches and inspect remote heads.
- [ ] Cross-model decision-trail audit and published resumable checkpoint.

throughput checkpoint: three independent workers maximum; coordinator integrates and judges units sequentially; no shared writer worktrees.
