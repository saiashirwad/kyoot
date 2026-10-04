# Independent contracts review

Verdict: NOT VERIFIED. Three compiler-accepted counterexamples still violate checked answer contracts. A12 and A13 behavior passed verification.

Reviewed exact integrated commit `2d62944582de14f2f5d601f83399aab34beaf70c` against `51f6619`, in `/Users/texoport/code/kyoot-cleanup`. HEAD was checked before and after verification. No source changes, commits, pushes, or child agents. Only temporary probe/report files were written. Read cleanup todo, handoff, design and contracts records, entire unit diff, surrounding core/model/runtime/async/resource implementation, package documentation and regression tests. Applied interrogate rubric, code-quality lens, lead judgment, and comment-sicko contract-comment exceptions. Existing compiler negative assertions were retained.

## Act on

### 1. P1: Contravariant requirement rows let ordinary type annotations bypass invariant contracts

Location: `packages/kyoot/src/model.ts`, Kyoot `_?: (s: S) => void`, interacting with new `Requirement` and declaration handler constraints in `core.ts:194-215`.

Reproducer: `/tmp/kyoot-astra-probe/intersection.ts`.

```ts
const N = effect<void, number>()("same");
const S = effect<void, string>()("same");
const widened: Kyoot<number, EffectRow<"same", void, number> & EffectRow<"same", void, string>> =
  N(undefined);
const answer: number = Kyoot.runSync(
  widened.pipe(S.handle({ onOp: (_, resume) => resume("bad") })),
);
```

Strict TypeScript accepts this with no casts, any, unsafe operations or suppressed diagnostics. Node prints `typed number; actual: bad string`. An intersection is a subtype of each original requirement, and contravariant Kyoot permits the annotation. The resulting row satisfies the wrong handler's constraint. Invariance inside Requirement does not make the containing contravariant row invariant.

The same root cause defeats runner masking fixes. `/tmp/kyoot-astra-probe/served-intersection.ts` assigns a checked `clock` string-answer operation to `Kyoot<string, EffectRow<'clock', void, string> & { clock: number }>`. Both runPromise and Async.all compile; runtime returns undefined and [undefined], typed string and string[].

Minimal root direction: make Kyoot requirement rows invariant (for example `_?: (s: S) => S`) and migrate generic adapters honestly. Verify ordinary row composition, pure computations, generic handlers, and all built-ins after that change. Adding another Requirement witness alone will not address the enclosing variance.

### 2. P1: Union dispatch keys permit wrong answers and remove unhandled effects

Location: `core.ts:229` distributes Answer over K, and checkedMakeHandler at `255-274` accepts union/broad keys while using `Omit<S, K>`.

Reproducer: `/tmp/kyoot-astra-probe/union.ts`.

```ts
const N = effect<void, number>()("n");
const S = effect<void, string>()("s");
const program = Kyoot.gen(function* () {
  if (Date.now() < 0) yield* S(undefined);
  return yield* N(undefined);
});
function handleEither(key: "n" | "s") {
  return makeHandler(key, program, {
    onOp: (_, resume) => resume("bad"),
  });
}
const result: number = Kyoot.runSync(handleEither("n"));
```

Strict compilation succeeds. Node prints `typed number; actual: bad string`. K distribution unions the answer types instead of intersecting them across possible runtime keys. Separately, `/tmp/kyoot-astra-probe/probe.ts` performs both n and s: compilation succeeds, then runSync throws unhandled effect s because one runtime handler removed both static keys.

Smallest coherent policy: require one literal dispatch key for public checked effect construction and makeHandler, keeping internal dynamic factories at an explicit trusted boundary. Merely retaining unmatched rows for uncertain keys fixes missing-effect tracking but does not repair union-answer resumption; that alternative also needs answer intersection across possible keys and conservative removal. A literal-key policy is smaller than maintaining both dynamic mechanisms, provided generic built-in factories have a deliberate internal path. A union-key declaration's handle/intercept must follow the same policy, not just raw-key makeHandler.

### 3. P1: Var's any answer witness is structurally compatible with a checked fixed-answer declaration

Location: `effects/var.ts:5-7`, `Requirement<VarOp<V>, any, V>`.

Reproducer: `/tmp/kyoot-astra-probe/var.ts`.

```ts
const N = Var.tag<number>()("n");
const S = effect<Var.VarOp<number>, string, {}, number>()("var/n");
const result: number = Kyoot.runSync(N.get().pipe(S.handle({ onOp: (_, r) => r("bad") })));
```

Strict compilation succeeds; Node prints `typed number; actual: bad string`. User code contains no any, casts, or explicitly unsafe APIs. This is a leak from the documented dependent implementation boundary into the new checked declaration API. Making Kyoot invariant alone will not distinguish structurally compatible Requirement witnesses containing any.

Minimal root direction: give dependent requirements a distinct nominal family marker that checked fixed-answer Requirement cannot satisfy. Retain trusted internal dependent handling as intended, but prevent checked fixed-answer declarations from consuming that family. Check the reverse direction as well, since Var.run currently also accepts matching fixed custom contracts through any.

## Verification

- `pnpm -F kyoot typecheck`: passed with existing @ts-expect-error assertions intact.
- `pnpm -F kyoot test`: 201 tests passed, zero failures. Log `/tmp/kyoot-astra-test.log`.
- `pnpm typecheck`: all five workspace packages passed. Log `/tmp/kyoot-astra-typecheck.log`.
- All four retained counterexample files (union.ts, intersection.ts, served-intersection.ts, var.ts) compiled under strict TS7 with noUncheckedIndexedAccess, target es2022, module nodenext, noEmit, allowImportingTsExtensions, skipLibCheck, and explicit Node types. `/tmp/kyoot-astra-probe/package.json` declares type module.
- Compiler invocation: `./node_modules/.bin/tsc --ignoreConfig --noEmit --strict --noUncheckedIndexedAccess --skipLibCheck --allowImportingTsExtensions --target es2022 --module nodenext --types node --typeRoots /Users/texoport/code/kyoot-cleanup/node_modules/@types /tmp/kyoot-astra-probe/union.ts /tmp/kyoot-astra-probe/intersection.ts /tmp/kyoot-astra-probe/served-intersection.ts /tmp/kyoot-astra-probe/var.ts`.
- Run each retained probe with `node /tmp/kyoot-astra-probe/<name>.ts`.
- Direct wrong-answer resume.with was independently rejected. Existing tests reject direct incompatible same-key merged requirements, wrong interceptors, payload widening, literal answer widening, and direct reserved-key misuse through fork/race/all/streams.
- Undefined extraction and actual undefined payload delivery passed.
- Copier sibling/nested isolation, shared references, and fresh scope tests passed. Existing Resource child-scope completion, typed failure cleanup, and fork:none tests also passed. Source inspection confirms copier runs in inherit separately for each spawn and completion hooks remain scoped appropriately.

## Design and nonblocking notes

The chosen copier contract is small and honest. It avoids a generic cloning mechanism and preserves resource ownership. The checked raw-key/declaration-handler split has a clear reason: only a declaration carries continuation requirements. No additional abstraction is warranted there.

The public package exports the checked makeHandler, but core.ts retains an internal makeHandler alias to unsafeMakeHandler. This is documented and not a separate correctness blocker; explicit internal naming would make future reviews easier. The trusted runFiber boundary is likewise disclosed. The findings above do not invoke it.

No new comment-deletion finding warrants action. API contract documentation belongs on the keep list; @ts-expect-error tests are executable rejection checks, not implementation suppressions. The changes do not cross the rubric's 1000-line threshold or add a substantial branch-heavy abstraction.

Existing tests prove the original literal-key regressions and fork behavior but do not prove the broad statement that checked contracts are sound under ordinary TypeScript annotations. Add the concrete counterexamples above as regression coverage after correcting the type model.
