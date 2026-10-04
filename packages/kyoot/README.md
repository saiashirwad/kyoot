# kyoot

The core: algebraic effects, handlers, fibers, and built-in effects (`Async`, `Clock`, `Emit`, `Env`, `Fail`, `Log`, `Random`, `Resource`, `Retry`, `Sync`, `Var`).

Start with [`examples/checkout.ts`](examples/checkout.ts) (your own effects, swappable handlers) and [`examples/env.ts`](examples/env.ts); the rest of [`examples/`](examples) and [`test/`](test) are the docs.

## Checked effect contracts

`effect<Payload, Answer, Continuation>()(key)` requires one known literal string key and records all three types in the program's requirement row. `Continuation` defaults to `{}` and lists effects that `resume.with` may perform at the operation site. Two declarations with the same key and identical contracts interoperate. A handler or interceptor with a different payload, answer, or continuation contract is rejected, including literal widening and unions of incompatible requirements.

```ts
const Count = effect<void, number>()("count");
const Text = effect<void, string>()("count");
Count(undefined).pipe(Count.handle({ onOp: (_, resume) => resume(1) }));
// Type error: the same key does not make these contracts compatible.
Count(undefined).pipe(Text.handle({ onOp: (_, resume) => resume("one") }));
```

Handwritten fixed-answer rows use `Requirement<P, A>` or `EffectRow<K, P, A>`. A nonempty continuation contract uses `Requirement<P, A, V, C>` or `EffectRow<K, P, A, C, V>`. `V` defaults to the payload type; `Env` uses it for an independent requirement value. `EffectRow` describes the operation's own entry. The performed program also carries the continuation requirements as separate row entries, so they must be handled before running it. Optional continuation entries are materialized as required program keys because a handler may perform them; an annotation cannot erase them. Union continuation rows merge requirements per key, so an annotation cannot select a narrower answer branch. Every union branch key remains tracked even when the handler resumes without effects. For union continuation contracts, `resume.with` permits only keys common to the alternatives. `Payload<S, K>` extracts the performed payload and retains `undefined`. `Emit.value(e)` requires `Requirement<E, void>` and `Fail.fail(e)` requires `Requirement<E, never>`.

A program can acquire additional independent requirements through a type annotation, but an annotation cannot change an existing entry by intersection, union, or widening. A declaration's continuation row cannot contain its own operation key. `Env.tag` and `Var.tag` also require one literal ID. Union keys, broad strings, and open template strings cannot identify the single runtime key that a checked handler removes.

`makeHandler(key, program, hooks)` requires one known key and extracts the payload and answer from a fixed-answer row. It rejects raw and dependent rows. When a key has several answer requirements, its resume accepts only values satisfying all of them. For a generic wrapper whose row is still abstract, use `Effect.handler(program, hooks)`. It also supports `onSuccess`, state, and the declaration's continuation requirements. Raw-key `makeHandler` permits only effect-free programs in `resume.with`; use the declaration for a richer continuation contract.

`Sync`, `Async`, `Resource`, and `Var` have dependent answers. Their row types carry distinct private family markers, so fixed declarations cannot handle them even when their runtime key and payload match. Use `Sync.SyncRow`, `Async.AsyncRow`, `Resource.ResourceRow<S>`, and `Var.VarRow<Id, V>` for explicit annotations. The ordinary `Sync.run`, asynchronous operations, `Resource.run`, and Var get/set/update/run methods preserve their built-in answer relationships.

General replacement of a dependent answer requires explicit opt-in through `Sync.unsafeHandle`, `Sync.unsafeIntercept`, `Async.unsafeIntercept`, `Resource.unsafeIntercept`, or a Var tag's `unsafeIntercept`. `Emit.intercept` and `Fail.intercept` retain their checked fixed answers. `unsafeOp` and `unsafeMakeIntercept` are also unchecked facilities. These APIs, type assertions, and `any` can bypass the checked contracts.

## State inherited by child fibers

Handlers default to `fork: "share"`. Child handlers have separate state slots but initially reference the parent's state value. Replacing a child's state slot does not replace the parent's slot. Mutating a shared object changes that object for all owners. The old `"copy"` spelling has been removed.

Pass a function to isolate mutable state according to your data's semantics:

```ts
Count.handle({
  create: () => ({ count: 0 }),
  fork: (state) => ({ ...state }),
  onOp: (_, resume, state) => resume(++state.count),
});
```

The runtime calls the copier separately when each child inherits the handler. Siblings never reuse a single copied snapshot, and nested children apply the copier again to their immediate parent's state. A shallow copier still shares nested objects. Shared and copied handlers omit the parent's completion hooks. `"scope"` creates fresh state and keeps the handler's completion hooks; `Resource.run` uses it for child resource scopes. `"none"` excludes the handler from inheritance.

`runPromise` checks the runtime's `clock` and `async` contracts as well as their names. Compatible custom declarations may use those keys. Fork, race, all, and stream conversion retain incompatible requirements so they cannot bypass that check. `runFiber` remains a trusted low-level boundary accepting erased effect rows.
