# NOT VERIFIED

This verdict applies to the superseded `Required<C>` revision identified by the hashes below. The coordinator subsequently changed `Performed` to merge continuation entries with `MergeAll<Required<C>>` and reports a passing focused typecheck. That subsequent repair is not reviewed here; a fresh verifier will assess it.

Reviewed `/Users/texoport/code/kyoot-cleanup`, HEAD `df093065096b7c2714eed0ccfabb71f9cca8cc23`, with the private independent continuation-key witness and `Performed` changed to `Simplify<{ [k in K]: V } & Required<C>>`.

The original optional-key mismatch and the ordinary/generic/union/mapped optional-key erasure probes now reject correctly. A separate union-narrowing path still returns a string where strict TypeScript promises a number. This is a blocking public-API correctness failure with no explicit `any`, assertions, unsafe APIs, or internal runners.

## Blocking repro

`/tmp/kyoot-continuation-union-narrow.mts`:

```ts
import { effect, Kyoot, type EffectRow } from ".../packages/kyoot/src/index.ts";
type Numbers = EffectRow<"s", void, number>;
type Strings = EffectRow<"s", void, string>;
type C = Partial<Numbers> | Partial<Strings>;

const Source = effect<void, number>()("s");
const Wrong = effect<void, string>()("s");
const N = effect<void, number, C>()("n");

const narrowed: Kyoot<number, EffectRow<"n", void, number, C> & Strings> = N(undefined);
const pure = narrowed.pipe(
  N.handle({ onOp: (_, r) => r.with(Source(undefined)) }),
  Wrong.handle({ onOp: (_, r) => r("wrong answer") }),
);
const result: number = Kyoot.runSync(pure);
console.log("typed number:", result, "runtime typeof:", typeof result);
```

Strict compiler: exit 0. Runtime: exit 0, output:

```text
typed number: wrong answer runtime typeof: string
```

The same program with `type C = Numbers | Strings` also compiles and returns the same incorrect value: `/tmp/kyoot-continuation-required-union-narrow.mts`. This is not limited to optional properties.

## Cause

`Required<C>` preserves union alternatives, and `Simplify` distributes over the intersection with those alternatives. The resulting performed row is a union of complete row shapes. The contravariant row witness in `Kyoot` allows that row union to narrow to one branch.

The narrowing retains exactly the same `n` requirement and full `C`, so both invariant witnesses agree. It changes only the outer `s` entry from the number-or-string alternatives to the string branch. The matching `N` handler is still permitted to select the number source through `resume.with`. After handling `n`, the narrowed `s` requirement admits the string handler, which resumes a number-typed operation with a string.

The earlier union tests normalize through a handler before checking the outer continuation requirement, so they do not test this annotation before handling. The performed row must account for every permitted answer at each key without allowing a whole-row union to select one contract. A merged per-key representation such as `MergeAll<Required<C>>` is a possible repair direction; it is not implemented or validated by this review and may affect conservative disjoint-union behavior.

## Verified checks

- `/tmp/kyoot-optional-continuation.mts`: rejected at the incompatible declaration handler.
- `/tmp/kyoot-optional-row-erasure.mts`: rejected at the annotation.
- `/tmp/kyoot-optional-variants.mts`: direct annotation, generic invocation, union annotation, and mapped annotation each reject. Log: `/tmp/kyoot-continuation-final-repro-types.log`.
- Fresh rerun of 65 existing probes: all match their expected results, comprising 62 rejected probes and 3 accepted controls. Logs and structured results: `/tmp/kyoot-continuation-final-matrix/`; summary: `/tmp/kyoot-continuation-final-matrix.log`.
- New `/tmp/kyoot-continuation-final-adversarial.mts`: 14 negative assertions pass. Ten matching optional paths execute and return 11, including handlers inside/outside, direct handler, interceptor, inferred generic C, mapped C, union C, nested optional C, generator, and flatMap. Disjoint union with pure continuation returns 29; safe abort of conflicting answer union returns 31.
- Existing `positive.mts` and `union-controls.mts` from `/tmp/kyoot-contracts-final-astra-probes` compile and run successfully, including required/nested/generic/disjoint union/optional controls and safe abort of a union answer.
- The coordinator reports `CI=true pnpm check` passed on this source: all workspace typechecks and 308 runtime tests. This review did not duplicate that full run. The new counterexample is absent from those tests.
- No source edits or commits by this review. `git diff --check` passed before the final counterexample.

## Reproduction command and logs

Run from the reviewed checkout:

```sh
./node_modules/.bin/tsc --ignoreConfig --strict --noUncheckedIndexedAccess \
  --exactOptionalPropertyTypes false --noEmit --target es2022 \
  --module nodenext --moduleResolution nodenext \
  --allowImportingTsExtensions --skipLibCheck --types node \
  --typeRoots /Users/texoport/code/kyoot-cleanup/node_modules/@types \
  /tmp/kyoot-continuation-union-narrow.mts
node /tmp/kyoot-continuation-union-narrow.mts
```

Optional-union logs: `/tmp/kyoot-continuation-union-narrow-types.log` (empty, successful compile), `/tmp/kyoot-continuation-union-narrow-runtime.log`.

Required-union logs: `/tmp/kyoot-continuation-required-union-narrow-types.log` (empty, successful compile), `/tmp/kyoot-continuation-required-union-narrow-runtime.log`.

TypeScript 7.0.2; Node v26.10.0.

## Reviewed SHA-256 hashes

```text
1c7d5faf815468790dcfc97f23cf1b3e35ff6b96978595bd38b9f681c46c2f5f  packages/kyoot/src/core.ts
f968f59551104e032d88116ad05ea25368e19a91e05107c02f299708e87baac9  packages/kyoot/src/model.ts
587ce1199614297f5f754321ca8da94bcda81456dd5c51ee36a5e6c6243115fd  packages/kyoot/src/types.ts
b91dca1cf610cfbe84aa10ae4a872e50eab852bc3e5bab18bbfbd4ccdfb2c5b6  packages/kyoot/src/runtime.ts
0b0179b2acba1585669d3c46ec8a3f6d8d02b290b2b4212d82e41570ab839e7c  packages/kyoot/test/continuation-contract.test-d.ts
58f48272f7c64b8054d63a72dae44b90afadc2fe42a8b1a58913d10d0fff3e4a  packages/kyoot/test/contracts.test.ts
d7bcde1a055ac47044a8987d4e9d226e3274b0c20e03f24747f4408b2dc966f7  packages/kyoot/test/contract-repair.test-d.ts
daff72757227bfea28cab5c034c6da55e3eb969663e1164f922ed0b26bb94e6d  packages/platform/test/fs.test-d.ts
```
