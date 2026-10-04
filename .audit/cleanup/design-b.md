# Candidate B: execution-owned turns and contract-bearing effects

Grounded against `421ad78` and the local `todo.md`; design only. Full persistence and process-restart recovery are outside this cleanup.

## Problem and traced model

`AI.make` owns one mutable `messages` array (`packages/ai/src/ai.ts:19-36`). Its `step` generator pushes the user message before calling `generate`; `generate` owns a local `added` array and appends it to conversation history only after returning (`generate.ts:63-83`). `Retry.run` reevaluates the same Kyoot program (`effects/retry.ts`), so a failed later model request loses a successful tool receipt and repeats the side effect. Two concurrent `ask` calls can both read and mutate the same array without an order. `needsApproval` performs approval inside a tool (`tool.ts:25-35`), so approval and execution need separate step identities to explain a retry.

The core machine dispatches by string key alone (`machine.ts:394-400`); the effect row stores a payload-shaped value and loses answer type (`core.ts:171-191`). `Payload` explicitly strips `undefined`. Fork snapshots hold `unknown` state references (`machine.ts:503-511`); `inherit` installs those references as initial state (`core.ts:225-230`). `Resource.run` uses its own handler state/finalizer stack and `fork: "scope"`; it should remain a scope, not a clone. `Registry.use` registers an entry then waits for activation inside `Async.fromPromise`; cancellation rejects the caller while activation can later land, orphaning the removal handle (`registry/src/index.ts:56-75`).

## Usage first

```ts
const agent = AI.make({ tools: [chargeCard] });
const turn = agent.ask("charge invoice 42"); // this call creates a logical turn
const answer = await Kyoot.runPromise(
  turn.pipe(Retry.run({ times: 1 }), model, approvals, Emit.discard, Fail.orThrow),
);
// A retry of `turn` resumes its recorded model/tool steps. A new ask() call creates a new turn.
// agent.messages exposes a readonly snapshot of the ordered transcript, including completed
// steps of a still-open turn.
```

```ts
const a = agent.ask("first");
const b = agent.ask("second");
// Running a and b concurrently gives each one a serialized turn on this agent.
// b's first model request sees a's completed transcript; order is ask() creation order.
// A direct run of the same turn during its first run joins that run or fails clearly;
// it never starts a second execution of its tool steps.
```

```ts
const Counter = effect<void, number>()("counter");
const program = Counter(undefined).pipe(
  Counter.handle({
    onOp: (_payload, resume) => resume(1),
  }),
);
// effect<string, string>()("counter").handle(...) cannot handle Counter's row.
```

```ts
const Local = effect<void, number>()("local");
Local.handle({
  create: () => ({ count: 0 }),
  fork: { copy: (s) => ({ count: s.count }) },
  onOp: (_, resume, s) => resume(++s.count),
});
// A child and parent receive distinct objects. Resource.run retains fork: "scope".
```

## Shape: turn and step ownership

The public AI surface remains `make/ask/gen/generate`; a single `Conversation` object owns ordered turns. `ask` constructs a `Turn` _outside_ `Kyoot.gen` and returns a reusable program referencing it. A new `ask` call constructs a new turn. Its first execution admits it to the conversation's FIFO queue. The queue protects both the transcript snapshot and the complete model/tool decision sequence for one conversation. Do not hold a language-level mutex around a suspended Kyoot continuation: represent the queue as an async gate with cancellation removal, and release it on settled/cancelled turn. A failed but retryable turn keeps its place and gate until retried or explicitly abandoned; fresh turns cannot silently overtake its partial external actions. Expose `agent.abandon(turn)` (or a `TurnProgram.abandon()` method) to preserve its audit transcript and release the queue. Concurrent calls to the _same_ turn share one in-flight execution or reject `TurnAlreadyRunning`; never run twice. A queued distinct turn observes caller cancellation and leaves the queue without ever appending its prompt. Avoid deadlock by requiring the host to abandon a failed turn when it will not retry; make the pending state visible rather than silently executing a later prompt.

Suggested internal types (names provisional):

```ts
type TurnStatus = "new" | "running" | "retryable" | "done" | "abandoned";
type Step =
  | { kind: "model"; request: Request; state: "running" | "done"; completion?: Completion }
  | { kind: "approval"; call: ToolCall; state: "running" | "done"; allowed?: boolean }
  | {
      kind: "tool";
      call: ToolCall;
      args: unknown;
      state: "planned" | "running" | "done" | "unknown";
      content?: string;
    };
interface Turn<A> {
  readonly id: symbol; // in-memory identity, not a durable ID
  readonly input?: string;
  readonly schema?: Schema<A>;
  status: TurnStatus;
  readonly transcript: Message[]; // append once at each completed boundary
  readonly steps: Step[];
  round: number;
  cursor: number;
}
interface Conversation {
  readonly committed: Message[];
  active?: Turn<unknown>;
  readonly queue: Turn<unknown>[];
  admit<A>(turn: Turn<A>): Promise<void>; // FIFO; cancellation removes waiting turns
  abandon(turn: Turn<unknown>): void;
  snapshot(): readonly Message[];
}
```

`generate` becomes a driver over an owned turn, rather than a generator with disposable `added`. It records the user message once when admitted; a completed model response and its assistant tool-call message before dispatching any tool; an approval decision before execution; and a tool result immediately after execution, before `Events.emit`. Each resumed execution consults `cursor` and consumes already completed steps. Validate that a replay sees the same request/tool-call identity and argument bytes, or use the stored model completion rather than invoking the model again. Successful model calls need not repeat. If a model call failed before completion, retry it. If a tool is interrupted or defects after starting, mark its outcome `unknown`; a retry raises `StepOutcomeUnknown` rather than guessing that re-execution is safe. A genuinely idempotent tool may opt into a replay policy later, at the tool boundary. The existing `Events` union is notification, not the authoritative step store.

`AI.messages` should become a readonly snapshot getter. This is an intentional API change: callers cannot mutate history behind the queue. `generate(messages, ...)` creates a standalone in-memory turn when called, preserving its one-shot return shape and resuming when that same returned program is retried. It has no shared conversation queue. Keep tool result content a string, including void result (`"null"` is a candidate encoding), and reserve the structured-answer name before execution. Those protocol fixes remain separate from step ownership.

A prompt followed by a model failure is a pending turn, not a successful exchange. Its prompt appears once in the transcript. An explicit abandonment should record an end marker internally (not a provider `Message`) before allowing a fresh turn. That avoids feeding an unexplained partial assistant tool call to the next model request. If the product wants to continue after abandonment, build a well-formed provider request from completed protocol exchanges plus an explicit recovery note; do not leak an orphan tool call.

## Shape: effect contracts and fork state

Keep string runtime keys for this cleanup, but make effect rows carry both payload and answer. The answer must be invariant so two declarations with the same key and payload but different answers fail to compose through `.handle`:

```ts
interface OpContract<P, A> {
  readonly payload: P;
  readonly answer: (value: A) => A; // invariant under strictFunctionTypes
}
type Performed<K extends string, P, A, C extends Row> = Kyoot<
  A,
  MergeAll<{ [Key in K]: OpContract<P, A> } | C>
>;
type Payload<S, K extends PropertyKey> = K extends keyof S
  ? S[K] extends OpContract<infer P, unknown>
    ? P
    : never
  : never;
type Answer<S, K extends PropertyKey> = /* extract invariant A from contract */ unknown;
```

The illustrative `Payload` conditional needs to infer via a distributive helper rather than `OpContract<infer P, unknown>` if invariance blocks inference. `effect.handle` should accept only a row whose slot is assignable to its exact `OpContract<V,A>`; `makeHandler` should preferably accept an effect descriptor for checked user effects, leaving an explicitly named raw-key primitive for interpreter built-ins. `V` (currently the row's public payload override, used by Var) must be carried in the contract while the operation payload remains `P`. Migrate `Var`, `Fail`, `Async`, and other hand-written rows together; otherwise a local fix to `effect` leaves a weak alternate route. `Var` deliberately combines get/set/update with different answer types under one key; split those into distinct operation keys or encode a tagged operation/answer relation instead of retaining `any` in its row. Type tests should demonstrate the same-key counterexample fails and `undefined` remains a valid payload. Runtime string-key collisions with equal TypeScript contracts remain possible; a later tokenized identity would solve nominal identity at a larger migration cost. At minimum, document that same-name declarations are one runtime operation family and should share a contract.

Replace misleading `fork: "copy"` with an explicit copy function (`fork: { copy(state): St }`), alongside `"scope"` and `"none"`. A copied handler clones state when a fork snapshot is captured, isolating subsequent parent mutation, and clones again for each inheritance of a reusable snapshot so siblings are distinct. `scope` calls `create` in each child; `none` does not cross. The caller owns deep-copy semantics of its state graph; the runtime only enforces that a copier exists and invokes it at the boundary. Do not silently `structuredClone`: state may contain closures, handles, or class instances. Built-in mutable collectors should choose an explicit share/merge policy if their current cross-fiber aggregation is intended; do not silently turn shared logs into invisible child-only logs.

## Shape: registry cancellation ownership

`Registry.use` must retain responsibility for an entry until either a handle is delivered or the entry is fully removed. Pass the `Async.fromPromise` abort signal into a cancellation path. On abort, mark `target=false`, await the existing serialized `transition`/deactivation, remove the entry, and track this cleanup in the registry so `settled()` and `dispose()` wait for it. If setup lands concurrently with abort, the target check must force deactivation before the entry disappears. `dispose` closes admission before tearing down entries. A reusable helper can make `use` and `remove` idempotent under repeated cancellation. Do not assume the rejected caller awaits the callback's cleanup: `Fiber` can reject before the promise settles (`runtime.ts:135-183`).

## Structural alternatives

| Shape                                                                                               | Benefit                                       | Why it loses here                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purely functional AI: `generate(history) -> [answer, nextHistory]`, caller persists after each step | Small core, no shared mutable object          | A caller using whole-turn `Retry` still discards receipts; every caller must build a step store and serialization rule.                                               |
| Global journal/interpreter checkpoint                                                               | Could eventually span process restarts        | Live Kyoot generators, closures, and continuations are not serializable (`model.ts`, `machine.ts`); adds infrastructure without resolving unknown external outcomes.  |
| Nominal effect tokens throughout the machine                                                        | Strongest defense against same-key collisions | Requires changing every key-based built-in, row, runtime dispatch, and raw handler. Contract-bearing rows stop the observed answer unsafety with a smaller migration. |
| Implicit deep clone for `fork: "copy"`                                                              | Simple call site                              | Invalid for closures/resources and masks the state owner's intended share/merge semantics.                                                                            |
| Return a registry handle before activation                                                          | No orphaned handle on cancel                  | Changes `use`'s await-ready contract; caller then needs a second readiness protocol. Cancellation-owned cleanup preserves existing use.                               |

## Regression contracts and counterexamples

- A1: Script tool success, next model typed failure, then Retry once. Tool counter equals one; first prompt appears once; assistant call and tool receipt remain; retry starts at next model request. A separate first-model failure leaves one pending prompt and no assistant/tool receipt. Concurrent distinct asks on one AI instance are FIFO, cannot interleave requests or transcript, and the second sees the first completed turn; retry of first turn retains its position. Running the same returned turn twice cannot perform a tool twice.
- A1 unknown: Interrupt a tool after external action begins and before a receipt. Retry reports unknown outcome; no second action. A safe per-tool replay policy is a separate opt-in.
- A8: Interrupt `Registry.use` during delayed setup, then release setup. `settled()` observes no active/landed entry or binding; disposal is idempotent. Race abort against the exact landing point.
- A11: `effect<string, number>()("same")` operation cannot be handled by `effect<string, string>()("same").handle`, even when payloads match; compatible same-key contract remains composable. Compiler and runtime tests should cover built-in raw wrappers too.
- A12: `effect<undefined, number>()` and generic `makeHandler` expose `payload: undefined`, not `never`; runtime handler receives `undefined`.
- A13: Parent and two children each mutate copied object state and observe independent counts; a nested object test demonstrates the supplied copier's responsibility. Resource scope still releases independently in parent and child; existing collector sharing is explicitly preserved or changed with matching tests.

## Next implementation unit

Prove the A11/A12 type contract sketch in an isolated compile probe, then add the turn/step owner around the existing `generate` loop with an A1 failure-after-tool regression before touching persistent infrastructure.
