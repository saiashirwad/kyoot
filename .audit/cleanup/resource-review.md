# A3/A4 resource review

Verdict: **VERIFIED** for the reviewed tree diff against `421ad78`.

Diff identity: `git diff 421ad78 | shasum -a 256` = `dd5b949819c96ce67db1874b4621ef3c667dcbf570fc855d77f43bd865c81ad1`. The diff changes `packages/kyoot/src/effects/resource.ts`, `packages/kyoot/src/runtime.ts`, `packages/kyoot/test/generator.test.ts`, and `packages/kyoot/test/resource.test.ts`. The `.audit/` files are untracked and outside that hash.

The red log has 4 failing resource cases before the implementation: both runners skipped cleanup on an unhandled operation, a typed release failure skipped an older release, and a typed release failure displaced a body defect. The green log has 196/196 tests passing and a successful TypeScript check. I independently ran `pnpm --filter kyoot test` (196/196 passing), `pnpm --filter kyoot typecheck` (exit 0), and `git diff --check 421ad78` (exit 0).

Direct public API probes used `node --input-type=module` against `./packages/kyoot/src/index.ts`:

| Case                                                                                          | Observed                                                                                                                                                       |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two typed releases fail                                                                       | LIFO events `new, old`; `Fail.run` returns the first release failure (`new-fail`).                                                                             |
| Body defect, newer release defect, older typed release failure                                | LIFO events `new, old`; the returned defect is the original body `Error` by identity.                                                                          |
| Synchronous unhandled body operation; newer release requests Clock; older release fails typed | Older release runs; caller receives the original `runSync encountered unhandled effect 'probe-missing'` error. The Clock release cannot complete in `runSync`. |
| Fiber unhandled body operation; newer release awaits Clock; older release fails typed         | Async release completes, older release runs, and the fiber rejects with the original `fiber encountered unhandled effect 'probe-missing'` error.               |
| Fiber interruption; newer release awaits Clock; older release fails typed                     | Async release completes, older release runs, and the fiber rejects with `InterruptedError`.                                                                    |

The implementation sends each unsupported operation into `Machine.raise`; both runner loops retain the first boundary error if cleanup completes and a handler would otherwise convert it to success. `Resource.finalize` collects `Fail.run` results for every finalizer in reverse acquisition order. `onSuccess` replays the first release error; `onDefect` rethrows the body defect after cleanup; `onInterrupt` performs cleanup before interruption resumes. The generator expectation change to `release, outer` matches the newly reachable resource cleanup when an unhandled operation occurs inside a dropped continuation.

No functional defect was proved in this scope. The direct probes cover combinations absent from the added tests; they are command-line evidence, not persistent regression tests.

Comment-sicko review of the introduced diff: one comment was deleted from `generator.test.ts`. One newly introduced suppression in `resource.test.ts` (`// @ts-expect-error Exercise the untyped runner boundary.`) is a deletion candidate under the strict policy: it suppresses a meaningful type error to exercise the runtime edge. **MUST KILL:** the sync unhandled-effect test case should expose that runtime boundary without suppressing TypeScript's unhandled-effect check. No other comments or suppressions were introduced; the unrelated existing comment at `generator.test.ts:485` was skipped. No source edits were made in this review.
