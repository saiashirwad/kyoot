# Continuation contract review (dd35814)

**Recommendation:** use the writer's invariant fourth `Requirement` parameter and require the exact `C` at every checked effect entrypoint. This directly closes the reported substitution: a declaration whose operation key, payload, answer, and value match another declaration can no longer install a handler with a different continuation row. It needs no runtime change and preserves the existing conservative behavior of `makeHandler`.

## Why the bug exists

`effect<P,A,C,V>()(K)` currently performs a program whose row is `{K: Requirement<P,A,V>} & C`, while `effect.handle`, `effect.handler`, and `effect.intercept` match only `Requirement<P,A,V>`. The handler's `resume.with` checks its own `C`, but the result of `resume.with` is a pure resume token. `unsafeMakeHandler` removes `K` from the input row and adds only hook return rows. Thus installing a same-key handler with a different `C` can execute an operation absent from the final row; the supplied reproducer gets `undefined` where TypeScript says `number`.

## Small repair

```ts
export interface Requirement<P, A, V = P, C extends Row = {}> {
  readonly [requirement]: {
    readonly kind: "fixed";
    readonly payload: (value: P) => P;
    readonly value: (value: V) => V;
    readonly answer: (value: A) => A;
    readonly continuation: (row: C) => C;
  };
}

export type EffectRow<K extends string, P, A, C extends Row = {}, V = P> = {
  [Q in K]: Requirement<P, A, V, C>;
};
```

The function-valued `continuation` property is invariant under `strictFunctionTypes`; it is phantom metadata inside the existing private `requirement` symbol. Thread `Requirement<P,A,V,C>` into the `Performed` row, both `effect.handle` and `effect.handler` input bounds, and the `V` supplied to `makeIntercept` by `effect.intercept`. The `EffectRow` fourth argument exposes `C` for users defining corresponding row types; the fifth preserves `V` without changing existing three-argument uses. Leave `Payload`, `Answer`, `FixedRequirement`, and `DependentRequirement` as they are: their checks inspect other fields and dependent effects have separate unsafe interceptors.

`Resume.with` already checks the replacement program against `Partial<C>` and rejects keys outside `keyof C`; its return row is intentionally empty because it is a resume token. Once the operation entry carries exact `C`, a checked handler cannot borrow another declaration's allowance. `makeHandler` currently constructs `Hooks<..., C={}>`; that permits only a pure replacement through `resume.with`, while `Omit<S,K>` keeps continuation keys already present in the input row. It is sound to leave it conservative. Deriving `C` there would be a separate API feature and requires proving that all continuation keys remain in the output. `unsafeMakeHandler` remains an explicit unchecked boundary.

`Interception` already includes `RowOf<Ret>` for effects from the interceptor, and `Omit<S,K>` preserves the input continuation. Its input constraint must nevertheless use the new `Requirement<P,A,V,C>` so a wrong declaration cannot claim the same key. `next(payload)`'s `Performed` row then carries that contract and `C`.

## Consumers and row helpers

- `packages/kyoot/src/core.ts`: `Requirement`, `EffectRow`, `Performed`, `effect.handle`, `effect.handler`, and the `makeIntercept` type argument in `effect.intercept` change. The exported generic `Intercept`/`makeIntercept` need no signature reorder; their existing `V` argument receives the new requirement type at this callsite.
- `packages/platform/src/command.ts` declares a nonempty command continuation, `{ fail: Requirement<CommandError, never> }`. `packages/platform/src/node.ts` currently constrains `command?: Requirement<Command.Op, Command.Output>` (default `C={}`); update it to the exact continuation. A shared `CommandRow = EffectRow<"command", Op, Output, { fail: Requirement<CommandError, never> }>` used by the declaration and `provide` would prevent drift.
- Existing `FailRow`, `EnvRow`, `Emit`, `Log`, `Clock`, `AI Model`, and their helpers use the empty default `C={}` and need no generic changes. Dependent `Sync`, `Async`, `Resource`, `Var`, and filesystem rows use `DependentRequirement`. Payload and answer extraction continue to work with the added field.

## Alternative: propagate handler C into every return row

Adding the handler declaration's `C` to `effect.handle`/`effect.handler` results would report the effect performed by `resume.with`, even when its return value is the empty resume token. This could prevent the immediate false-pure result, but it leaves same-key declarations with different continuation contracts interchangeable and conservatively adds `C` even when the handler never resumes with a program. It also requires custom result typing at each checked handler surface; changing the lower-level `unsafeMakeHandler` default would pollute unrelated handlers with its default `C=Row`. The invariant witness gives a local contract check and uses the continuation already recorded in the performed row.

## Edge checks and strict proof

The independent probe is at `/tmp/kyoot-continuation-design-proof/packages/kyoot/probe.ts` with a snapshot of dd35814 and only the sketch above applied to its temporary `core.ts`. Command: `node_modules/.bin/tsc -p /tmp/kyoot-continuation-design-proof/packages/kyoot/tsconfig.json`; exit 0 with `strict`, `noUncheckedIndexedAccess`, and all negative `@ts-expect-error` assertions consumed. The probe checks exact-C acceptance, missing/wrong-C rejection through `handle`, `handler`, and `intercept`, `makeHandler`'s conservative replacement, operation-key overlap for a union or string index continuation, and harmless pure-program row extension. The original reproducer remains accepted on dd35814; its `undefined` runtime result is the reported failure.

For a disjoint union `C = {s: ...} | {t: ...}`, `Simplify<{K: Requirement<...,C>} & C>` currently retains only common keys (`K` here), so neither `s` nor `t` appears in the performed row. `Resume.with` also has `keyof C = never` and rejects either branch's effect, and the `Kyoot` row witness rejects hiding an actual effectful program behind a union with a branch missing that effect. This is conservative in the checked API and separate from the same-key mismatch. Do not expand it as part of this repair without deciding whether union `C` means alternatives or an upper bound of all branch effects. A broad string-index `C` is rejected because it overlaps the performed key. Pure programs may still be widened to a row with the requirement; they never invoke the handler and introduce no effect.
