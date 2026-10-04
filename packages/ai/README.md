# @kyoot/ai

Language models as kyoot effects, after [kyo-ai](https://github.com/getkyo/kyo/tree/main/kyo-ai): a program asks a `Model`; providers and modes handle it. Tested against mocked providers only.

See [`examples/deepseek.ts`](examples/deepseek.ts) and [`test/`](test).

`AI.make()` owns a conversation. Each `ask()` or `gen()` call creates one logical turn. Reexecuting the returned computation resumes that turn after a model failure, reuses recorded tool results, or returns its completed answer. It does not start another request.

```ts
const ai = AI.make({ tools: [writeFile] });
const turn = ai.turn("Write the report");
const answer = yield * turn.run.pipe(Retry.run({ times: 1 }));
```

Construct the turn before entering a generator that `Retry` may restart. Calling `ai.ask()` inside that generator creates a different turn on each attempt. Identical prompt text does not identify a turn. `ai.turn(schema, input)` creates a structured turn. Direct `generate()` calls retain the same execution state when their computation is reexecuted.

An unfinished turn owns its conversation, including between failed attempts. A competing turn or concurrent execution of the same turn fails with `TurnBusy`. Completed turns publish their transcript once. `ai.messages` returns a frozen snapshot of completed messages.

`turn.discard()` releases an unfinished conversation without publishing its partial transcript. It throws `TurnBusy` during execution. A discarded turn permanently fails with `TurnDiscarded`; discarding does not undo tool actions.

`ai.discard()` discards the conversation's current unfinished turn, including one created by `ask()` or `gen()`. It follows the same running guard and invalidates that turn's retained computation. It does nothing when the conversation has no unfinished turn.

Structured turns process every call in a model completion, in order. The first valid `answer` supplies the return value after all calls have receipts. Later valid answers receive an `ignored: answer already provided` receipt. Invalid answers, denied tools, and typed tool failures also receive receipts. A pending answer survives retryable approval or notification failures; an unknown tool outcome prevents the turn from completing.

Tool successes and typed failures become string receipts before result notifications. A tool defect or interruption leaves an unknown outcome, and later execution fails with `UnknownToolOutcome` instead of repeating the action. Approval decisions made by `needsApproval` are stored separately from action execution. Notifications are best effort; a failed notification is not delivered again. Streaming text from failed model requests can appear again on retry.

Accepted completions and their calls are copied and frozen. Mutating a provider's completion later cannot change the retained transcript or pending actions; event consumers receive frozen calls.

The state lives in memory. There is no process restart recovery or guarantee about an external action whose receipt was lost during a process crash.
