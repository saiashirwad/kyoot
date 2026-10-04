# Candidate A: explicit resumable turns and operation contracts

Read-only design grounded in the supplied audit and current source. No implementation or runtime verification was performed. The cleanup stops at in-memory state. It does not serialize generators, recover a process, or promise exactly-once external actions.

## Problem and source model

`core.ts` encodes an effect requirement as a string-keyed payload row. `Machine.handle` dispatches solely on that string. `effect` supplies the answer type only to its own handler callback, so it disappears before another same-key declaration handles the program. `makeHandler` further gives its resume an `any` answer type. `Payload` explicitly removes undefined. `MergeAll` unions requirements for the same key, which any replacement must preserve rather than silently select one member.

`Machine.crossed` captures state references. `inherit` creates another frame with that state as its initial value unless the hook asks for a fresh scope. Resource uses fresh scope. Therefore existing copy behavior means distinct state slots holding the same reference, with no object isolation.

`Retry.run` executes the same `Kyoot` value repeatedly. It does not roll back JS mutation. `AI.make.step` currently appends the user message inside its generator, and `generate` creates its `added` array inside its generator. Consequently Retry preserves the prompt mutation but loses model responses and successful tool receipts. `Events.emit(result)` occurs after the receipt is appended locally. A downstream event handler can fail after the action has happened.

`Registry.use` creates an Entry when the effect is constructed, pushes it when the promise runs, and transfers ownership only when the promise returns a Handle. Its promise ignores the supplied abort signal. Component fibers are independent `runFiber` roots. Registry owns them after successful acquisition, but no one retracts an interrupted acquisition. `refresh` currently has no retained registration flag to prevent a removed entry from becoming wanted again.

## Usage first

```ts
const convo = AI.make({ tools: [charge] });
const turn = convo.turn("Charge this order");
const answer = yield * turn.run.pipe(Retry.run({ times: 1 }));
// Executing turn.run again returns the completed answer without another charge.
// A distinct turn represents a distinct request, even when its text is identical.
const followup = convo.turn("What happened?");
yield * followup.run;
```

Keep `ask` and `gen` as conveniences that allocate one turn when called and return its `run`. Document the ownership boundary prominently: `Retry.run(convo.ask(text))` retries one turn; recreating `convo.ask` inside an outer retried generator creates new requests. Text equality never supplies identity. A named turn created outside the retried generator solves the latter case.

```ts
const Tick = effect<void, number>()("tick");
yield * Tick(undefined).pipe(Tick.handle({ onOp: (_, resume) => resume(1) }));
const TextTick = effect<void, string>()("tick");
// Rejected: the row retains the incompatible answer contract.
// Tick(undefined).pipe(TextTick.handle(...))

const Counter = effect<void, number>()("counter");
const scoped = Counter.handle({
  create: () => ({ n: 0 }),
  fork: (state) => ({ ...state }),
  onOp: (_, resume, state) => resume(++state.n),
});
```

## Shape and responsibilities

### A1: one owner for a turn's messages and steps

```ts
interface Turn<A, S extends Row> {
  readonly run: Kyoot<A, S>;
}
interface AI<T extends Tool> {
  readonly messages: readonly Message[];
  turn(input?: string): Turn<string, Requires<T>>;
  turn<A>(schema: Schema<A>, input?: string): Turn<A, Requires<T>>;
  ask(input?: string): Kyoot<string, Requires<T>>;
  gen<A>(schema: Schema<A>, input?: string): Kyoot<A, Requires<T>>;
}
type TurnState<A> =
  | { kind: "ready"; cursor: Cursor }
  | { kind: "running"; cursor: Cursor }
  | { kind: "done"; value: A }
  | { kind: "interrupted"; cursor: Cursor };
type Cursor =
  | { kind: "model"; round: number }
  | { kind: "tools"; round: number; completion: Completion; next: number };
```

These are illustrative public signatures and private data shapes, not compile-checked declarations. Use a private TurnRecord with a stable monotonically allocated identity, immutable input/schema/tool configuration, accumulated messages, and the cursor. Keep committed conversation messages private and return snapshots. Mutable public history would let outside callers invalidate recorded requests.

Move generator-local `added`, `round`, and tool index into the TurnRecord owned by the generation module. Creating or retrying its interpreter never resets that record. Append the prompt exactly once when the turn first acquires conversation ownership. Record a model completion before interpreting any of its tool calls. Record each tool outcome and advance `next` synchronously before yielding result notifications or another model request. A model failure leaves the model cursor intact; retry invokes that model request again against the recorded history. Completed tool calls are skipped because the cursor already passed them. Do not use provider call IDs as global idempotency keys. Their identity is the local turn, model-step index, and call index.

Preserve typed tool failures as their existing error-message outcomes. A tool defect or interruption is different: its external outcome can be unknown, so do not automatically execute it again. Make that turn terminally interrupted/defective unless a later, explicit recovery feature provides a per-tool policy. This bounds the guarantee precisely: completed, recorded tool outcomes are reused after later model failure. It does not claim protection across every possible external-action/receipt gap.

Choose a single conversation owner with fail-fast contention for this cleanup. While a turn is running, another turn returns a typed ConversationBusy failure without changing state. After a retriable failure, the failed turn retains the conversation slot so another turn cannot build on an unfinished exchange. Retrying that same turn is allowed. A completed turn releases the slot and publishes its messages once. Run calls on a completed turn return its cached answer. Concurrent runs of the same unfinished turn also fail busy rather than execute the cursor twice. The shared conversation is legitimately sequential data, and this contract is smaller than a cancellation-aware FIFO queue.

This choice needs a deliberate failure escape. Add `turn.discard(): Kyoot<void, ...>` only if the cleanup must support continuing a conversation after permanent failure. It must reject while running, release the owner, and leave committed history unchanged. It cannot undo tools already run. Do not silently release a failed turn and later resume it against a newer conversation history. If no discard API is added, explicitly document that a failed abandoned conversation must be replaced. My preference for the bounded cleanup is replacement, with discard deferred until the product needs it.

Direct exported `generate` must allocate the same record at function-call time and reuse it on reexecution. Otherwise it remains a second unsafe path. `AI` adds conversation ownership; it does not maintain another copy of generation progress. Successful direct generate returns the same value/messages pair again.

Streaming text notifications remain attempt-scoped. Model requests that fail can have emitted text already; replay can emit text again. Tool receipts remain authoritative state. This cleanup does not turn Events into a durable journal or exactly-once notification bus.

### A11 and A12: preserve answers in requirements

```ts
declare const requirement: unique symbol;
interface Requirement<P, A> {
  readonly [requirement]: {
    readonly payload: P;
    readonly answer: (value: A) => A;
  };
}
type EffectRow<K extends string, P, A> = { [Q in K]: Requirement<P, A> };
type Payload<S, K extends PropertyKey> = K extends keyof S ? S[K] : never;
```

Use an invariant answer witness, not just `answer: A`. A number-answer handler must not consume a never-answer or literal-answer requirement merely because one direction happens to be assignable. `effect` and its `intercept` require the full compatible requirement for their key. Same string plus same payload/answer contract remains legal and interoperable. Same string plus different answer contract is rejected before dispatch. If merging two declarations forms a union of incompatible requirements, the handler must reject the entire union rather than distribute and accept one branch.

The existing `V` override is used by Env and Var and represents a requirement value distinct from the performed payload. Preserve that distinction explicitly, e.g. `Requirement<V, A>`, with the effect declaration retaining its concrete P for callback typing. Do not use an intersection marker on V: undefined, primitives, and never make that shape unsuitable.

A12 itself is the direct removal of Exclude from Payload; optional row constraints may then expose undefined honestly. Do not hide optionality with Required, which can erase a deliberate undefined under some compiler settings. Where an API knows the row key is required, express that condition at its signature.

This requires migrating handwritten row declarations that correspond to `effect`, including AI model and approval rows. It also exposes a boundary that must be resolved explicitly: low-level `op<A>()` and `makeHandler` are currently public trusted primitives, and some built-ins are request-dependent rather than one fixed answer type. Do not advertise full soundness if these remain generic `any` resume APIs. Preferred cleanup: keep the trusted implementation primitive private, export a checked fixed-answer handler accepting an effect declaration, and migrate public examples to it. Internal Async, Resource, Sync, and Var may retain trusted implementations for their dependent results. If compatibility forces raw operations to remain public, name them unsafe and document that A11 is repaired for the checked `effect` API; broad unsafe imports cannot be called a sound API.

### A13: explicit copy function, honest sharing

```ts
type ForkPolicy<St> = "share" | "scope" | "none" | ((state: St) => St);
interface Cell<St> {
  readonly create: () => St;
  readonly fork?: ForkPolicy<St>;
}
```

Replace ambiguous `copy` spelling with `share`, migrate callers in one unit, and keep the existing slot/reference behavior as the default. A custom function provides isolation appropriate to the state. Execute it once per child inheritance in `inherit`, not in `Machine.crossed`: one captured snapshot can seed several children, so snapshot-time copying would still share across siblings. `scope` continues to create fresh state and preserve finalizers; share and clone continue to omit parent completion hooks. Carry clone policy through nested descendants. Document that clone is caller-supplied isolation, not a deep-copy guarantee. `structuredClone` cannot copy many valid handler states and must not be the default.

### A8: registry ownership transfers at handle delivery

Allocate Entry per execution, not when `use` constructs its Kyoot value. Wrap the entire acquisition in an internal handler whose interruption/defect cleanup removes that entry and awaits deactivation. The handle delivery continuation is inside that boundary, so cancellation between promise completion and interpreter resumption still cleans up. After successful return, registry owns the entry until remove/dispose. Do not detach an unobserved cleanup promise in an AbortSignal listener and claim cancellation has settled resources.

Add registration state to Entry and make desired activation depend on `registered && satisfied(entry)`. Removal sets registered false before triggering/awaiting transitions. That prevents dependency notifications from resurrecting an entry during cancellation cleanup. Use the same internal removal operation for interrupted acquisition and Handle.remove; it must tolerate repeated calls. No API expansion is necessary. Setup-failure behavior can retain the existing returned Handle.error contract, provided interruption cleanup cannot reactivate the entry.

## Alternatives considered

| Shape                                                  | What it hides                                  | Why it loses or wins                                                                                                                                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit in-memory turn record, reject competing turns | Model/tool cursor, receipts, committed history | Recommended. It establishes replay identity and preserves the current effect interpreter.                                                                                                                            |
| Queue every call and release on failure                | Concurrency order                              | Loses without extra reservation/version machinery: retry of an older turn can resume after later turns changed history. Holding the queue through failure can hang unrelated callers indefinitely.                   |
| Caller-supplied turn IDs and public journal API        | Very little beyond storage                     | Too much coordination exposed for an in-process repair; easy to mismatch identity and inputs. Reserve for durable execution later.                                                                                   |
| Unique runtime symbols for each effect declaration     | Runtime collision                              | Alone it leaves string rows claiming an unrelated handler removed the effect. Fully nominal symbols require row/API migration anyway. Contract rows preserve useful same-key interoperability.                       |
| Generic structuredClone fork                           | Deep copying for serializable data             | Breaks closures, resources, class instances, and ownership. A state-specific fork function expresses the only generally valid clone.                                                                                 |
| Registry-owned setup even when caller cancels          | Acquisition cancellation                       | Can intentionally work as registration, but current API gives the only removal handle after waiting. Changing ownership requires exposing a handle before await; more public surface than transactional acquisition. |

## Regression contracts

- The audited A1 script executes the tool once, records one user prompt and one tool receipt, and retries only the failed model step. Reexecute completed turn.run and prove no extra work occurs.
- A two-tool completion whose second tool fails after the first returns resumes from the first unresolved step only when failure is a known retriable pre-action outcome. Defects/interruptions never silently replay unknown actions.
- Failure in result-event handling after receipt commit does not rerun that tool. Model streaming emission is documented as attempt-scoped.
- Two simultaneous conversation turns cannot interleave histories. The loser gets Busy without mutations. Retry the owner after failure; a later fresh turn sees exactly one committed exchange.
- Demonstrate that recreating ask inside an outer Retry is a new turn and document use of an explicitly retained Turn.
- Same-key mismatched answer declarations fail compile tests for handle and intercept, including literal/supertype and union cases. Same contract remains accepted. Undefined payload survives generic extraction, including `string | undefined`.
- Sibling cloned object state is independent, parent state is unchanged, nested children invoke the clone again, share intentionally aliases references, and Resource scope still releases only its own resources.
- Interrupt Registry.use during suspended setup and in the promise-completed/continuation-not-delivered window. Await caller exit and settled; no active entry/provider remains. Repeat use of one Kyoot value creates distinct registrations. Dependency churn cannot resurrect removed entries.

## Paths and implementation order

Core contracts touch `packages/kyoot/src/core.ts`, `model.ts`, `types.ts`, public `index.ts`, effect wrappers, and handwritten rows in dependent packages. Fork behavior concentrates in `core.ts:inherit` with policy typing in model/hooks/cells. AI ownership belongs in `packages/ai/src/generate.ts` and `ai.ts`, with state private to those owners. Registry cleanup stays in `packages/registry/src/index.ts`.

First stabilize resource unwinding A3/A4 and runner cancellation semantics, because turn ownership and registry acquisition guards depend on reliable cleanup. Then implement effect contract migration and fork policy, then registry acquisition, then resumable generation plus conversation ownership. Each unit starts with its behavior/compile regression before integration. This candidate has no synthesized winner or accepted implementation deviations yet.
