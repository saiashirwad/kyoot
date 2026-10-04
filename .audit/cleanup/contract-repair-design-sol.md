# Candidate B: caller-owned operation identity

Read-only design for `kyoot-cleanup` at `2d62944`. This candidate is intentionally structurally different from Candidate A's string-keyed row plus invariant witness and single-literal string gate. It has not been compiled or implemented. It changes public operation declarations and is likely too expensive if preserving the current string-based ergonomics is a priority.

## Usage drives the shape

```ts
const tickId = Symbol("tick"); // inferred unique symbol
const Tick = effect<void, number>()(tickId, "tick");
const textTickId = Symbol("tick");
const TextTick = effect<void, string>()(textTickId, "tick");

const p = Tick(undefined);
const n: number = Kyoot.runSync(p.pipe(Tick.handle({ onOp: (_, resume) => resume(1) })));
// Compile error: TextTick has a different identity, despite its equal display name.
// p.pipe(TextTick.handle({ onOp: (_, resume) => resume('wrong') }));

// Compile error: a broad or union symbol does not identify one operation.
// declare const id: symbol;
// effect<void, number>()(id, 'unknown');
```

Keep string labels for diagnostics and tracing. The runtime operation key is the supplied symbol, and `Machine.handle` compares symbols. The symbol is supplied by the caller because a generic factory cannot mint a fresh `unique symbol` _type_ for each call. `const x = Symbol()` does; `effect()('x')` cannot.

## Contract sketch

```ts
type Row = Record<PropertyKey, unknown>;
type IsUnion<T, C = T> = T extends C ? ([C] extends [T] ? false : true) : never;
type SingleSymbol<I extends symbol> = symbol extends I ? never : IsUnion<I> extends true ? never : I;

declare const requirement: unique symbol;
interface FixedRequirement<P, A, V = P> {
  readonly [requirement]: {
    readonly mode: 'fixed';
    readonly payload: (p: P) => P;
    readonly answer: (a: A) => A;
    readonly value: (v: V) => V;
  };
}
interface DependentRequirement<Family, V> {
  readonly [requirement]: {
    readonly mode: 'dependent';
    readonly family: (op: Family) => Family;
    readonly value: (v: V) => V;
  };
}

type Same<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;
type CheckEntry<S, I extends symbol, R> = I extends keyof S
  ? Same<Exclude<S[I], undefined>, R> extends true ? unknown : never
  : unknown;

// S appears both as input and output. Make this required and inaccessible to callers,
// rather than an optional `_?` property that implementers might omit.
interface Kyoot<A, S extends Row> {
  readonly [rowWitness]: (row: S) => S;
  // existing map, flatMap, iterator, and private runtime node members
}

declare function effect<P, A, C extends Row = {}, V = P>():
  <const I extends symbol>(id: SingleSymbol<I>, label: string) => {
    (payload: P): Kyoot<A, { [K in I]: FixedRequirement<P, A, V> } & C>;
    readonly id: I;
    readonly label: string;
    handle<St, ROp, /* existing hook result parameters */> /* ... */:
      <B, S extends Row>(program: Kyoot<B, S> & CheckEntry<NoInfer<S>, I, FixedRequirement<P, A, V>>) =>
        Kyoot</* existing result union */, Omit<S, I> | /* hook rows */>;
  };
```

The syntax above is schematic where existing `Hooks` result type parameters are elided. Preserve their current `ROp`, `RSuccess`, `RDefect`, `RInterrupt`, `C`, state, and `Resume<A, St, C>` behavior. `CheckEntry` must be non-distributive and evaluated on the _inferred full row_, not a subtype chosen to satisfy a constraint. `Same` as bidirectional assignability is a starting proof obligation, not assumed sufficient for `any` or pathological intersections. Add an explicit `IsAny<T>` rejection for public fixed rows, and test it. Optionally reject `never` entries as well. A required invariant witness prevents ordinary assignment from `Kyoot<A, S1>` to `Kyoot<A, S2>` when the requirements differ. A private symbol in a public interface is an opaque nominal boundary: users can hold and compose returned Kyoot values but cannot manufacture one from an object literal.

The checked public handler takes the descriptor, not a free `string | symbol` key: `makeHandler(Tick, program, hooks)` if a standalone form remains necessary. `effect.handle` and `effect.intercept` derive identity and contract from one descriptor. Remove public `unsafeOp` and `unsafeMakeIntercept` exports; raw `op`, `makeOp`, `unsafeMakeHandler`, and `makeIntercept` remain internal implementation tools. If direct imports from `src/core.ts` count as a supported public API, move those tools behind a package-private module/export boundary. Runtime symbols and static rows must be derived from the same descriptor. With a bare `makeHandler(key, ...)`, a union key can still subtract two row members while handling one runtime key.

`Payload` must preserve undefined inside a fixed requirement. `Exclude<S[I], undefined>` above only removes optional _presence_ from a requirement-valued row; it must never be applied to `P` or plain/raw rows. `MergeAll` already obtains keys via `keyof`, so extend `Row` to symbol keys and confirm `Omit`, `Only`, `RowsOf`, `RowOf`, runner checks, and error reporting all work with them. `Machine.key` is already `PropertyKey`; the dispatch comparison needs the symbol while diagnostics use `label`.

## Dependent built-ins and migration

`Var` currently advertises `Requirement<VarOp<V>, any, V>` under one string key. Its `get` resumes with `V`, while `set` and `update` resume with `void`; the `any` is a trusted internal relation, not a fixed answer contract. A fixed `effect<VarOp<V>, V>()` can otherwise appear to handle `Var.get` and call `resume` with a `V` even when the operation is a `set`. Do not claim public checked handlers are sound while that crossing compiles.

Give the variable family a `DependentRequirement<VarOp<V>, V>` with an explicit `mode: 'dependent'` that cannot equal `FixedRequirement<..., ..., ...>`. Keep `Var.get/set/update` result types and `Var.run` as the one trusted interpreter for the family. Remove the current generic public `Var.intercept` or replace it with separately typed get/set/update interception that preserves the discriminant-to-answer relation; the current `Intercept<..., any>` is an unchecked public escape. The same audit applies to `AsyncOp`, Resource, Sync, Emit, Fail, and other raw/dependent families: public fixed-answer handlers cannot silently consume their rows. They can retain internal trusted interpreters; export checked, operation-specific wrappers when callers need customization.

The migration cost is substantial. `Env.tag<E>()('greeter')` and `Var.tag<V>()('Total')` must take caller-owned unique symbols (plus optional label), or their factory must use an explicit caller-supplied token object. A factory-generated symbol has static type `symbol`, which cannot distinguish independently created tags. Handwritten AI model/approval rows, runtime `ServedRow`, examples, docs, and type tests also migrate. `fail`, `async`, `resource`, `emit`, etc. currently use string rows, so a mixed transition needs a clear boundary: these are internal families handled only by their own trusted adapters, and the public generic fixed handler accepts only symbol-keyed `FixedRequirement`s. A completed migration would make all runtime dispatch keys symbols while retaining labels; a partial migration must document why the raw string families are not part of the checked public contract.

## Why this solves the two probes, and what it does not

The intersection probe uses the same runtime string for number and string effects and narrows a row to the string requirement. With separate symbol identities, `TextTick.handle` cannot subtract `Tick`'s row. Reusing one symbol with incompatible requirements is caught by `CheckEntry` on the full invariant row. The union probe passes `'n' | 's'` to `makeHandler`; there is no public key-taking handler. A union/wide symbol is rejected at declaration, and a handler accepts only its own descriptor.

The operation identity approach gives up same-string interoperability by design. Two declarations called `'tick'` remain independent unless they deliberately share one caller-owned symbol _and_ the same contract. It also forces new syntax at almost every public effect declaration. If retaining string-key interoperation and the existing `Env.tag('id')` call shape matters, prefer Candidate A with a truly invariant row, exact non-distributive contract checking, singleton literal keys, and removal of public unchecked primitives. Both candidates still need the dependent-family separation above; `any` in a row defeats either answer proof.

## Compile regression contracts

1. Existing intersection probe must fail at the checked handler call; ordinary assignment to a narrower `Kyoot` row must fail before handler use. Test same-key same-contract acceptance and same-key conflicting-contract rejection.
2. Existing union probe must fail because `makeHandler('n' | 's', ...)` is absent from the public API. Broad `symbol`, a union of two unique symbols, and a widened `symbol` variable must fail as operation IDs.
3. A `FixedRequirement<P, A>` handler must reject `FixedRequirement<P, B>`, their union, their intersection, `DependentRequirement<VarOp<V>, V>`, and a public row containing `any` or `never`. Check both `handle` and `intercept`.
4. `Var.get()` remains `Kyoot<V, VarRow>`, `set/update` remain `Kyoot<void, VarRow>`, and `Var.run` consumes the family. A fixed-answer `effect<VarOp<V>, V>` cannot handle any of them, even when deliberately given the same symbol.
5. A fixed effect with `P = undefined` and one with `P = string | undefined` retain those exact payload types in handler callbacks and `Payload`; optional row presence is tested separately.
6. `runSync` and `runPromise` reject an unhandled symbol-keyed operation; `Only` names its label or symbol in the type diagnostic. `MergeAll` preserves two distinct symbol entries across `gen` and `flatMap`.
7. Check generated `.d.ts` or package-root imports: no `unsafeOp`, `unsafeMakeIntercept`, raw `makeHandler`, or generic dependent `Var.intercept` is importable from `kyoot`.

## Design flags and recommendation

The descriptor bundles identity, label, payload, answer, and checked handling in one place, avoiding a hand-synced key list and preventing importable internal constructors through the package root. The major weakness is interface cost: caller-owned symbols make a simple tag declaration noisier, and a partial migration would leave two ways to declare operations. Migrate callers and delete old exports in one wave if choosing this design. For the present cleanup, Candidate A is smaller if its exact checks survive the probes. This candidate is a sound fallback when nominal operation identity is worth the API break; it is not a zero-cost patch to the existing string row model.
