# Audit checklist

- [x] 1. Route through the **how** skill. For motivation questions, also route through the **why** skill.
- [x] 2. Throughput checkpoint stays one line: `throughput checkpoint: n/a, read-only investigation`.
- [x] 3. Produce the `how`-shaped output (Overview / Key Concepts / How It Works / Where Things Live / Gotchas), or a recommendation with a tradeoffs table if the request is a decision between alternatives.
- [x] 4. Apply the **unslop** skill to the reply.

throughput checkpoint: n/a, read-only investigation

- [x] Frame
- [x] Fan out
- [x] Aggregate
- [x] Report
- [x] Run workspace checks and inspect delivery configuration.
- [x] Validate material findings against source or a reproduction.

## Locally tracked findings

- Whole-turn Retry after a tool succeeds and the next model call fails repeats the tool and duplicates the user prompt. Reproduced inline against current source.
- Node command interruption rejects the fiber while the child continues and writes a file. Platform explorer reproduced with a delayed child.
- Runner unhandled-effect errors skip resource releases in both runners. Reproduced inline against current source.
- A typed finalizer failure skips remaining resource finalizers. Reproduced inline against current source.
- Truncated provider streams report successful partial completion. AI explorer reproduced with a local ReadableStream.
- Void tool results produce undefined tool-message content. AI explorer reproduced.
- User tool named answer collides with the structured-output tool. AI explorer reproduced.
- Interrupted Registry.use may leave an active component without returning its handle. Registry explorer reproduced.
- Explicit output-limit policy and Memory.fs invalid descendant rename are lower-priority platform findings.

No-comments scope: skip: there is no tracked code diff to review in this read-only investigation.

- Same-key effects with different answer types compile, yet a typed string computation returns a number. Compiler and Node probes confirmed this.
- Generic Payload excludes valid undefined values, allowing a runtime undefined to be typed never. Compiler and Node probes confirmed this.
- fork copy shares mutable state references. Treat isolation as an explicit contract choice before parallel-agent sessions.

## Recommended order

1. Repair resource unwind and command cancellation with focused regression coverage.
2. Repair provider completion, tool-result encoding, reserved names, and effect identity contracts.
3. Introduce explicit turn and step state at the model/tool/approval boundary, then implement persistence and recovery with per-tool replay policies.
4. Repair interrupted registry setup if registry ownership is part of the harness.

Verification: CI=true pnpm check passed formatting, lint, workspace typechecks, and 249 tests. Local probes reproduced uncovered failures. No live-provider or process-restart recovery tests were run.

## Start a new session from this audit

Open `/Users/texoport/code/kyoot` and read this file before changing code. The audit examined commit `421ad78f5c3f4be16ab7b629879c2ecddb78570f`. Recheck the current checkout before carrying findings forward.

Implementation has not started. No source files changed during the audit. This file is a local, untracked artifact. A new session in this checkout can read it. A fresh clone or worktree needs a copy.

The audit baseline passed `CI=true pnpm check`. The suite contained 192 core tests, 22 AI tests, 14 platform tests, and 21 registry tests. The exploratory probes were run inline or from temporary files. They were not retained as a standalone verification suite. Use the recipes below to reproduce them and create regression coverage.

### Reproduce the findings

Line numbers refer to the audited commit. Each recipe records an observed failure unless explicitly marked as a contract choice.

| ID  | Source                                                                                 | Reproduction recipe and observed result                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `packages/ai/src/ai.ts:24-29`, `packages/ai/src/generate.ts:63-80`                     | Create an `AI.make` instance with a tool that increments a counter. Script the model to call that tool, fail the following request with `Fail.fail`, call the tool again on retry, and finally answer. Wrap the turn in `Retry.run({ times: 1 })`. The counter reaches two. The retained history contains two user prompts and only the second attempt's tool receipt. A separate failed-model probe leaves an unanswered user prompt in history.               |
| A2  | `packages/platform/src/node.ts:8-14,77-97`                                             | Run a Node child that writes a temporary file after 250 ms through `Command.run`, `Node.command`, and `Fail.orThrow`. Start it with `runFiber` and interrupt after 80 ms. The fiber rejects with `InterruptedError`, but the child still writes the file. The adapter does not forward the abort signal.                                                                                                                                                        |
| A3  | `packages/kyoot/src/runtime.ts:20-24,179-183`, `packages/kyoot/src/machine.ts:271-281` | Acquire a resource whose release appends to an event array. Perform an unhandled custom effect afterward and apply `Resource.run`. Exercise both runners from JavaScript so the static unhandled-effect check does not prevent the boundary probe. Both runners report the unhandled effect, but the event array contains acquisition without release.                                                                                                          |
| A4  | `packages/kyoot/src/effects/resource.ts:23-45`                                         | Acquire two resources. Make the newest resource's release record its invocation and return `Fail.fail('release failed')`. Apply `Resource.run` and `Fail.run`. The result contains the typed failure, but only the newest resource is released. A thrown defect follows a different path and permits remaining releases.                                                                                                                                        |
| A5  | `packages/ai/src/providers.ts:75-96`, `packages/ai/src/sse.ts:35-36`                   | Supply a local streaming response containing a complete SSE event with `choices[0].delta.content` set to `partial`. Close the stream without a terminal completion marker. The provider returns a successful completion with partial text, no tool calls, and zero usage. The provider also lacks validation for assembled tool-call IDs and names. That validation gap was observed in source, rather than established as a separate malformed-response probe. |
| A6  | `packages/ai/src/generate.ts:33-40,77-79`                                              | Register a tool returning `Kyoot.succeed(undefined)`. Script a model tool call followed by a final answer. Inspect the next request's tool message. Its content is `undefined`, and JSON serialization omits the content field.                                                                                                                                                                                                                                 |
| A7  | `packages/ai/src/generate.ts:56-62,74-80`                                              | Call `AI.gen` with a user tool named `answer` and script valid answer calls. The user tool is executed instead of returning the structured answer. The loop exhausts eight rounds and produces `TooManyRounds`.                                                                                                                                                                                                                                                 |
| A8  | `packages/registry/src/index.ts:56-75`                                                 | Keep a `Registry` alive outside a caller fiber. Use a component whose setup waits on a controllable promise. Interrupt the caller while `registry.use(component)` waits for setup, then release setup and await `registry.settled()`. The component becomes active and landed, but the caller never receives its removal handle. Dispose of the registry after the probe.                                                                                       |
| A9  | `packages/platform/src/node.ts:77-97`                                                  | Run a child that successfully emits about 1.1 MB to stdout. The adapter returns `CommandError` with `stdout maxBuffer length exceeded`. This exposes an implicit output policy. Choose and test an explicit bound or streaming behavior before treating large output as a supported tool result.                                                                                                                                                                |
| A10 | `packages/platform/src/memory.ts:83-99`                                                | Create `/d/sub/x` in the memory filesystem and rename `/d` to `/d/sub/moved`. The operation succeeds. Repeat the equivalent operation in an isolated real temporary directory. Node rejects it with `EINVAL`.                                                                                                                                                                                                                                                   |
| A11 | `packages/kyoot/src/core.ts:171-186`, `packages/kyoot/src/machine.ts:394-400`          | Declare `Numbers = effect<string, number>()('same')` and `Strings = effect<string, string>()('same')`. Handle `Strings('value')` with `Numbers.handle`, resuming with `123`. The compiler accepts a `string` result, while execution returns the number `123`. Effect rows carry the key and payload but do not enforce the answer contract across declarations.                                                                                                |
| A12 | `packages/kyoot/src/core.ts:189-191`                                                   | Declare an effect with an `undefined` payload. Handle it through generic `makeHandler` and assign the callback payload to a `never` variable. The assignment compiles, although the payload is `undefined` at runtime. `Payload` excludes a valid payload value.                                                                                                                                                                                                |
| A13 | `packages/kyoot/src/core.ts:225-230`, `packages/kyoot/src/machine.ts:503-511`          | Give a handler object state containing a counter and use `fork: 'copy'`. Increment it in a child, then increment it in the parent. Results are one and two because both see the same object reference. This is a verified behavior with an unresolved isolation contract, rather than a defect against an established deep-copy guarantee.                                                                                                                      |

### Execute the cleanup queue

Use the new session's instruction to establish execution authority. The previous discussion described an autonomous workflow but did not start implementation or authorize merging.

1. Capture regression evidence for each finding before repairing it.
2. Repair A2, A3, and A4 as resource and cancellation work. Repair A8 as registry lifecycle work.
3. Repair A5, A6, and A7 at the AI protocol boundary.
4. Resolve A11 and A12 as effect-contract work. Settle A13's isolation contract with design exploration and concrete tests.
5. Give A1 explicit turn and step ownership. Keep successful tool outcomes independently of whole-turn success. Test failure after an external action and concurrent calls on one conversation.
6. Resolve A9's output policy and repair A10's filesystem parity.
7. Run independent review and the full workspace checks on the integrated result. Verify against exact commits and inspect the actual behavior.

Use poteto-mode's `figure-it-out` workflow to define independently verifiable units, then its Autonomous run playbook to execute them. Use isolated worktrees for independent writers. Route API and data-shape changes through `architect`. Use `swarm` for independent verification and `interrogate` for contested design. Apply `deslop` before commits and `no-comments` before review. Keep a decision trail and resumable checkpoints.

Use reasonable defaults for ordinary implementation choices. Resolve empirical questions through source inspection or experiments. Follow the authority granted in the new session for commits, pushes, PRs, and merges. Do not confuse worker self-reports with independent verification.

### Keep the persistence objective explicit

Full persistence and process-restart recovery are future work, separate from repairing these findings. The proposed cleanup endpoint is sound lifecycle behavior, validated AI messages, sound effect contracts, and explicit turn and step ownership ready for a durable execution layer.

The current interpreter stores live closures and generators in `packages/kyoot/src/model.ts:19-70`. It has no serializable continuation API. The proposed persistence boundary sits above it at model requests, tool execution, and approval decisions. The existing event union in `packages/ai/src/events.ts:4-7` contains text, call, and result events, but is not a complete recovery journal.

For a later persistence objective, use stable run, turn, and step identities with recorded inputs and outcomes. A process crash after an external action but before saving its receipt leaves an unknown outcome. Define reconciliation or idempotency per tool. Do not claim that journaling alone guarantees exactly-once external actions.
