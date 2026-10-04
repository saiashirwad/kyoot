# Independent core-contract review

**Target:** `2d62944582de14f2f5d601f83399aab34beaf70c` versus `51f6619`, in `/Users/texoport/code/kyoot-cleanup`. The checkout was at the exact target SHA. I made no source edits, commit, PR, or push. An untracked `.audit/cleanup/contracts-integrated.log` was already present and was left alone.

**Method:** Read the handoff, selected design, contracts rationale, changed core/runtime/effect code, nearby machine and model code, public README, and contract regression tests. Applied the interrogate rubric and code-quality lens as one independent reviewer. Ran `CI=true pnpm check` on the target checkout and compiled independent negative probes from `/tmp/kyoot-contract-probe.mts` using TypeScript 7 and the repository's compiler options. The first temporary compiler invocation had an invalid `/tmp` module setup; after changing the probe to `.mts` and resolving Node types, the compiler run succeeded. The final probe retains `@ts-expect-error` assertions on intended rejections. They are part of the negative evidence, not errors to delete.

## Verdict

**VERIFIED:** The intended A11/A12 static boundaries hold for tested typed declarations. Invariant requirement witnesses reject mismatched answer and payload declarations, including literal widening and merged incompatible rows. Generic raw-key `makeHandler` extracts `undefined` payloads and rejects wrong checked answers. A separate compiler probe also rejected direct declaration handlers over incompatible merged rows and nested/heterogeneous reserved-key masking. The static assertions are meaningful because an unused `@ts-expect-error` fails the typecheck.

**VERIFIED:** A13 explicitly distinguishes sharing, fresh scope, and per-child copy. Source inspection shows the copy callback runs inside `inherit` once per inherited child handler, while machine snapshot capture retains the source state. The runtime regressions exercise siblings, nested children, parent state, sharing, and scope. The full check passed, including 201 core, 22 AI, 23 registry, and 34 platform runtime tests, all package typechecks, formatting, and lint.

**VERIFIED:** `runPromise` constrains `clock` and `async` row values, and `Async.fork`, `race`, and `all` retain incompatible served rows. `Emit.toAsyncIterable` checks the same driver contracts. Negative compiler probes covered a bad clock directly, each combinator, heterogeneous `all`, nested forks, and stream conversion; all expected errors were present.

**NOT VERIFIED:** No end-to-end runtime probe was added for a reserved-key mismatch because the fixed contract is compile time and the typed negative tests establish the intended rejection. The full runtime suite does not make a claim about deliberately bypassing types with `any`, casts, or the named unsafe entry points.

**INCONCLUSIVE:** No production defect was proven in the target change. The public `makeHandler` has a deliberate soft edge: `AnswerOf<T>` falls back to `any` for a raw row value, and `ServedRow` permits raw `number`/`AsyncOp` for trusted built-ins. A caller who handwrites a raw row or uses `unsafeOp` can bypass the checked answer witness. This is disclosed in the README and is a trusted boundary, so it is not an A11 regression. The code could make that distinction more obvious in the public signature, but changing it would require a separate API decision.

## Design notes

The added requirement witness is a small local type mechanism; it preserves the independent Env/Var value without runtime metadata. The `checkedMakeHandler`/`unsafeMakeHandler` split keeps raw-key continuation requirements narrow and gives declaration-bound `handler` the richer `C` contract. `inherit` reuses the existing snapshot machinery and has no extra shared cache. I found no branch or helper in the changed core that can be removed without weakening the stated distinction between share, scope, none, and user copy.

One maintainability wrinkle is the internal `export { unsafeMakeHandler as makeHandler }` alias in `core.ts` beside the public `checkedMakeHandler as makeHandler` re-export in `index.ts`. It is valid and lets internal imports keep working, but a maintainer importing from `core.ts` sees a different contract under the same name. I classify this **Consider**, not a blocker. The API surface is honest at the package entry point; a future internal rename could make the trust boundary clearer without altering behavior.

The `@ts-expect-error` comments in the declaration tests encode expected compiler failures. Removing them mechanically would stop the tests from detecting a widened contract. Ordinary explanation comments in the changed code are limited; no comment-driven workaround or hidden lifecycle mode surfaced in the reviewed slice.
