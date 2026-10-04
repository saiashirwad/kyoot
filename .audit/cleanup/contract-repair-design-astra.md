# Contract repair candidate: invariant entries, checked keys, separate dependent contracts

Read-only design against the current kyoot-cleanup sources. No workspace changes. The architect skill and its design-red-flags checklist were read. Phase status: grounded existing signatures; two structural alternatives compared; recommendation and compile probe produced; implementation remains with the owner.

## Recommendation

Keep row key extension contravariant, but make each existing row entry invariant. Require a single statically known dispatch key wherever handling removes that key. Separate fixed-answer requirements from dependent-operation requirements using a non-optional discriminant. Do not let checked fixed handlers consume raw or dependent entries. These are three distinct obligations; fixing only the answer witness does not satisfy them.

Caller behavior:

```ts
const N = effect<void, number>()("n");
const n = N(undefined);
// Both remain legal:
const pureWithN: Kyoot<number, EffectRow<"n", void, number>> = Kyoot.succeed(1);
const withExtra: Kyoot<number, EffectRow<"n", void, number> & EffectRow<"s", void, string>> = n;
// These must fail:
// const forged: Kyoot<number, EffectRow<'n', void, number> & EffectRow<'n', void, string>> = n;
// makeHandler(keyOfTypeNOrS, n, ...)
// effect<VarOp<number>, string, {}, number>()('var/counter').handler(Var.tag<number>()('counter').get(), ...)
```

The expected guarantee excludes deliberate `any`, assertions, and explicitly unsafe facilities. Checked exported wrappers must not introduce those escape hatches on behalf of their callers.

## Grounded failure paths

`Kyoot._?: (s:S)=>void` permits replacing a required row value by a subtype. An intersection of two incompatible Requirement instances is a subtype of each instance, even though each Requirement contains invariant witnesses. Therefore N is assignable to Kyoot with the conflicting intersection, and the string handler accepts that row. Invariance inside Requirement does not make the enclosing row invariant.

`checkedMakeHandler` takes K as PropertyKey and removes Omit<S,K>. With K = 'n'|'s', runtime handles one key and the return type removes both. Computing an intersection of resume answer types does not solve this: an aborting handler or a never answer still cannot remove the other runtime key. The factory `effect` has the same problem if created from a union or wide key.

`VarRow` currently uses Requirement<VarOp<V>,any,V>. A fixed effect with the same P and V and answer string can satisfy this structural contract; both invariant answer witnesses still accept any. The Var operation's answer depends on whether it gets, sets, or updates, so a single fixed-answer witness cannot encode it.

`Performed` currently intersects the newly performed requirement with C. A caller can supply C with the same key and a conflicting Requirement. That constructs the unsafe intersection directly, bypassing any later prohibition on row reassignment. Reject overlapping C at the checked factory boundary, or replace this intersection with MergeAll and reject the resulting incompatible union during handling. Rejection is the smaller contract.

## Minimal signature changes

```ts
type RowEntries<S> = {
  [K in keyof S]: (value: S[K]) => S[K];
};
interface Kyoot<A, S extends Row = {}> {
  readonly _?: (s: RowEntries<S>) => void;
  // Existing map, flatMap, iterator, runtime-node and pipe members.
}
```

This is an invariant witness around the whole entry, not merely its answer. Under strictFunctionTypes, N cannot become N intersect S or N union S at the same key. Additional distinct keys remain legal because the outer parameter is contravariant. A pure row remains assignable to a row with extra requirements. Removing an existing key remains illegal.

Keep mapped-property optionality intact; do not apply Required to payload extraction. A property with payload `undefined` and an optional requirement are different facts. Avoid optionalizing actual performed requirement keys.

```ts
type IsUnion<T, Whole = T> = T extends Whole ? ([Whole] extends [T] ? false : true) : never;
type SingletonKey<K extends PropertyKey> = [K] extends [never]
  ? never
  : true extends IsUnion<K>
    ? never
    : {} extends Record<K, unknown>
      ? never
      : K;

// Factory key boundary, schematic:
<const K extends string>(key: K & SingletonKey<K> & (K extends keyof C ? never : unknown)) =>
  FixedEffect<K, P, A, C, V>;
```

The `Record` condition matters. Testing only `string extends K` fails to reject infinite template keys such as `var/${string}` or `${number}`. A mapped record over these accepts the empty object; a required concrete literal key does not. Reject never and finite unions separately. Put NoInfer around secondary uses of K where hooks or program types might otherwise steer its inference. The exact call signature needs integration probes, including explicit generic arguments.

`makeHandler` must apply the same singleton check to its dispatch parameter. Checked effect handles obtain their key from the already validated factory. Env/Var tag factories need validated literal IDs too; the internal construction of `env/${id}` may require one private proof bridge because TypeScript cannot necessarily propagate the singleton predicate through generic template construction. Do not reopen an unchecked public constructor to avoid that internal limitation.

```ts
declare const requirement: unique symbol;
interface Requirement<P, A, V = P> {
  readonly [requirement]: {
    readonly kind: "fixed";
    readonly payload: (value: P) => P;
    readonly answer: (value: A) => A;
    readonly value: (value: V) => V;
  };
}
interface DependentRequirement<P, V = P> {
  readonly [requirement]: {
    readonly kind: "dependent";
    readonly payload: (value: P) => P;
    readonly value: (value: V) => V;
  };
}
```

Var uses DependentRequirement. Async, Sync, and Resource need a corresponding dependent/private capability contract rather than raw rows being accepted by the fixed checker. A private family brand can distinguish dependent protocols if sharing the same P/V would otherwise let two unrelated protocol handlers cross. Env is fixed answer and stays Requirement<void,E,E>.

The checked makeHandler parameter must require the selected entire entry to be a fixed contract (or a union entirely of fixed contracts), non-distributively. Remove `AnswerOf`'s fallback to any. A dependent/raw/unknown entry must reject the call, not produce a Resume<any>. Same-key unions of fixed requirements can be handled only if the payload handler covers their union and the resume value satisfies every answer contract. Alternatively reject heterogeneous entries entirely; the simpler supported surface can require an exact single Requirement. Whichever policy is chosen must be tested explicitly.

Dependent built-ins remain responsible for their own answer relation. Merely branding their row does not make existing `Sync.handle` or `Var.intercept` checked. `Sync.handle` currently hands out Resume<unknown> for a request with a hidden concrete answer, allowing arbitrary replacement. Var.intercept similarly exposes any. Remove these general replacement APIs from the checked surface, or give them a separate proved polymorphic/request-indexed contract. Observation APIs that cannot replace the answer are a possible future feature, not required for this repair. Trusted built-in implementations may use private erased runtime types; users should not need casts or any.

## Two structural alternatives

### Whole row invariance

`readonly _?: (s:S)=>S` blocks row intersection reassignment directly and is the clearest rule. But it also rejects pure -> effectful annotations and N -> N plus independent requirements. Every API that previously accepted weakened programs needs generic row parameters or a checked weakening operation. Such an operation must verify every existing key remains present with exactly the same entry and admit only new keys; a bare `widen<T>()` simply reintroduces the original bug. This is viable if breaking implicit weakening is intentional. It adds caller obligations for a property the existing effect model reasonably expects.

### Contravariant keys with invariant entries (recommended)

The mapped witness retains implicit addition of independent requirements while preventing strengthening or widening existing contracts. There is no new public method and no runtime state. It does not automatically allow widening an error payload or unioning different contracts at one key by assignment. Programs that actually combine effects use gen/flatMap's MergeAll to construct their honest merged row. Failure-row variance may need a separate deliberate policy later; do not silently special-case all payload rows now.

This candidate avoids the red flags of a second unchecked construction path and caller-managed weakening. Its main implementation risk is TypeScript's behavior through the recursive Kyoot iterator and generic helper types. The isolated algebra passes, but full source integration has not been compiled.

## Evidence and integration limits

`/tmp/kyoot-repair-types.ts` is a small independent algebra probe, compiled successfully with:

```
./node_modules/.bin/tsc --ignoreConfig --strict --noEmit --skipLibCheck /tmp/kyoot-repair-types.ts
```

It proves expected diagnostics for intersection strengthening, requirement erasure, same-key union laundering, unknown-entry widening, generic index-row widening, finite union keys, string/symbol keys, and infinite string/numeric template keys. It also proves acceptance of pure weakening, adding a distinct requirement key, a literal key and a unique symbol key. This is compiler evidence for the algebra only, not verification of the complete public API.

## Required compile regression contracts

1. Re-run the supplied intersection.ts and union.ts against package exports; both must fail without casts/any/unsafe imports.
2. Preserve accepted pure -> fixed requirement and adding an unrelated key through assignment, function arguments, returns, and pipe.
3. Reject explicit generic attempts to pick a wider S/K; reject key union, string, open template, branded-open string, never, and symbol where supported.
4. A program genuinely using n and s cannot run after a runtime-selected handler handles only one of them. Narrowing with an actual switch permits handling one branch while preserving the other requirement.
5. Preserve valid same-key identical contracts; reject mismatched answers for handle, handler and intercept, including literals, never, unknown and unions. Verify union entries are checked as a whole.
6. Reject overlapping K/C at effect creation, including broad index C. C containing independent requirements still works and Resume.with still preserves its required dependencies.
7. Reject a fixed string-answer effect consuming Var.get<number>, even when P and V match. Reject checked makeHandler over Var/Sync/Resource/Async dependent entries.
8. Keep Var get/set/update/run and Env provide's real usage compiling. Built-in dependent replacement/interception exports must be either properly typed or outside the checked surface.
9. Undefined payload extraction preserves void, undefined and string|undefined exactly. No Exclude/Required workaround.
10. Compile the whole monorepo after migrating hand-authored requirements and generic helper annotations. Run existing runtime tests to show marker-only changes do not alter interpreter behavior.

Ownership remains concentrated: row variance in model.ts, entry/key checking and contract distinction in core.ts, dependent semantics in each built-in, and export decisions in index.ts. Do not duplicate singleton or contract-admissibility checks across downstream packages.
