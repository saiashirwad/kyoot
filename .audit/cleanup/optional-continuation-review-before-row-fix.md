# NOT VERIFIED

Reviewed `/Users/texoport/code/kyoot-cleanup`, HEAD `df093065096b7c2714eed0ccfabb71f9cca8cc23`, with the uncommitted private `RequirementShape<P, A, V, C, Keys>` fix. No repository source changes or commits were made by this review.

The original optional-continuation repro is rejected by the current source, but an ordinary row annotation still erases the optional continuation requirement while preserving the exact operation declaration. Strictly typed code then both loses effects and can return a string where the compiler promises a number.

## Blocking finding: optional outer row keys remain erasable

`core.ts:142` preserves optional properties in `C` through `Simplify<{ [k in K]: V } & C>`. The invariant entry witness in `model.ts` is a homomorphic mapped type and also preserves optional properties. Consequently a target row can omit `s?: ...` altogether even while retaining the exact `n` requirement, including the new continuation key witness. The handler is compatible with `n` and resumes with `s`; its output omits `n` from an input row that has already lost `s`.

Minimal strict, public-API repro, with no `any`, assertion, unsafe API, or internal runner:

```ts
import { effect, Kyoot, type EffectRow } from ".../packages/kyoot/src/index.ts";

const Source = effect<void, number>()("s");
type Continuation = Partial<EffectRow<"s", void, number>>;
const Optional = effect<void, number, Continuation>()("n");

const erased: Kyoot<number, EffectRow<"n", void, number, Continuation>> = Optional(undefined);
const pure = erased.pipe(Optional.handle({ onOp: (_, r) => r.with(Source(undefined)) }));
const value: number = Kyoot.runSync(pure);
```

`/tmp/kyoot-optional-row-erasure.mts` compiles with exit 0 and produces `Error: runSync encountered unhandled effect 's'` at runtime (exit 1).

`/tmp/kyoot-optional-variants.mts` also compiles with exit 0. It checks ordinary, generic, union, and mapped continuations, then attaches a string-valued `s` handler to the erased program. Runtime output:

```text
direct runSync encountered unhandled effect 's'
generic runSync encountered unhandled effect 's'
union runSync encountered unhandled effect 's'
mapped runSync encountered unhandled effect 's'
typed number: wrong answer runtime typeof: string
positive: 7
```

The generic case uses a normally typed function returning a row annotation without the optional entry. The union case uses `Partial<SourceRow> | SourceRow`; the mapped case uses `{ readonly [K in keyof SourceRow]?: SourceRow[K] }`. The wrong-value result is explicitly annotated `number`. The positive matching optional case includes the correct `s` handler and returns 7.

The new private fifth argument fixes declaration equivalence; it does not ensure every permitted continuation key remains present in the performed program's row. Materializing continuation row keys or changing the row witness's treatment of optional keys are possible repair directions, but neither was implemented or validated by this review.

## Checks and evidence

- Original `/tmp/kyoot-optional-continuation.mts`: rejected, exit 1, with TS2345 at the incompatible handler. Log: `/tmp/kyoot-optional-continuation-original-probe.log`.
- Minimal new erasure repro: strict compile exit 0; runtime exit 1. Logs: `/tmp/kyoot-optional-row-erasure-types.log`, `/tmp/kyoot-optional-row-erasure-runtime.log`.
- Generic/union/mapped and wrong-value repro: strict compile exit 0; runtime confirms every failure. Logs: `/tmp/kyoot-optional-variants-types.log`, `/tmp/kyoot-optional-variants-runtime.log`.
- `CI=true pnpm check`: exit 0. Formatting, lint, all workspace typechecks, and 308 runtime tests pass (205 core, 36 platform, 23 registry, 44 AI). Existing required-C, row/key, dependent, and filesystem type regressions are included in the passing workspace typecheck. Log: `/tmp/kyoot-optional-continuation-full-check.log`.
- `git diff --check`: exit 0.
- TypeScript 7.0.2; Node v26.10.0.

Standalone compile command, run from the reviewed checkout:

```sh
./node_modules/.bin/tsc --ignoreConfig --strict --noUncheckedIndexedAccess \
  --exactOptionalPropertyTypes false --noEmit --target es2022 \
  --module nodenext --moduleResolution nodenext \
  --allowImportingTsExtensions --skipLibCheck --types node \
  --typeRoots /Users/texoport/code/kyoot-cleanup/node_modules/@types \
  /tmp/kyoot-optional-variants.mts
```

## Reviewed SHA-256 hashes

```text
8e1c277f94b99cecd965648ff25d238a0a815defec016c225f3393fa4f645d46  packages/kyoot/src/core.ts
f968f59551104e032d88116ad05ea25368e19a91e05107c02f299708e87baac9  packages/kyoot/src/model.ts
587ce1199614297f5f754321ca8da94bcda81456dd5c51ee36a5e6c6243115fd  packages/kyoot/src/types.ts
b91dca1cf610cfbe84aa10ae4a872e50eab852bc3e5bab18bbfbd4ccdfb2c5b6  packages/kyoot/src/runtime.ts
0e58b4ab41dfb97c0ad35b0e7521db2f8b289754afe2a6472162f72ca27835d6  packages/kyoot/test/continuation-contract.test-d.ts
58f48272f7c64b8054d63a72dae44b90afadc2fe42a8b1a58913d10d0fff3e4a  packages/kyoot/test/contracts.test.ts
d7bcde1a055ac47044a8987d4e9d226e3274b0c20e03f24747f4408b2dc966f7  packages/kyoot/test/contract-repair.test-d.ts
daff72757227bfea28cab5c034c6da55e3eb969663e1164f922ed0b26bb94e6d  packages/platform/test/fs.test-d.ts
```
