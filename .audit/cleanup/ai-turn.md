# Retained AI turns

The architecture comparison used design-a.md and design-b.md from the coordinator's cleanup artifacts. The independent design-judge.md selected A's explicit turn and fail-fast ownership. B's FIFO queue and public recovery protocol add admission and cancellation semantics that this cleanup does not need. The selected grafts retain model completions, receipts before notifications, and approval decisions separately from actions. design.md records that accepted contract.

## API and ownership

`ai.turn(input)` and `ai.turn(schema, input)` return a Turn with a retained `run` computation and synchronous `discard()`. Existing ask and gen allocate a turn at call time. Direct generate also allocates its progress outside the restartable generator. The conversation owns completed history and one unfinished turn identity. Generation owns model completion, next call, approval decision, receipts, and final value. The record has model, calls, unknown, and done variants.

Resource scopes protect each running execution and release the running guard on success, typed failure, defects, and interruption. The conversation owner survives failed executions until completion or explicit discard. Discard fails while running, leaves completed history intact, releases ownership, and permanently invalidates the old computation. It cannot undo tool actions.

A successful model completion is retained before any tool notification. A successful or typed-failure tool receipt and the next cursor are retained before a result notification. Tool execution marks its outcome unknown before entry, so interruption, a thrown defect, or result serialization failure cannot silently repeat the action. needsApproval registers the wrapped tool in a private WeakMap so generation can record approval independently while direct invocation keeps its existing approval behavior.

Model the Domain shaped the progress union. Boundary Discipline kept provider validation outside generation. Deslop review preserved the existing generation loop and removed the old tool runner instead of adding a second execution framework. Frozen history snapshots isolate callers from owned messages.

## Evidence

`ai-turn-red.log` captures failing Retry regressions against the preceding protocol commit. The first model failure duplicated the prompt, and reexecuting a completed action requested the model again. `ai-turn-green.log` records the repaired suite. The audited successful action followed by model Fail and whole-turn Retry keeps the counter at one and publishes one prompt and receipt. Package typechecking passes.

Additional tests cover direct generate, multiple tools and receipt ordering, call and result notification failure, tool defects and interruption, concurrent same and distinct turns, retained failure ownership, explicit discard, completed replay, frozen history, and approval reuse. The prior approval test now constructs a fresh turn for its independent allow and deny cases. Reexecuting a completed turn deliberately returns its stored result.

No live provider calls or process recovery tests were used. Streaming text can repeat when a model request is retried. Tool notifications use an at-most-once attempt and are not a journal.

The coordinator's review requested a tool-list snapshot at turn construction. A regression first produced zero actions after the caller emptied its array. The fixed turn and direct generation copy that array at construction. UnknownToolOutcome also retains a caught tool defect as its cause, including on replay, while keeping the external outcome unknown.
