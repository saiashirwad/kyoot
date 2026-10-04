# Resource cleanup evidence

A3 concerns the runner boundary. A suspended unhandled operation must enter Machine.raise so handler finalizers execute before the runner fails. The synchronous runner can unwind synchronous cleanup only. If cleanup itself requests an unsupported operation, it raises that boundary error through remaining scopes.

A4 concerns the release loop. Every finalizer must be attempted in LIFO order. The loop records tagged failures or defects and replays the first release error after all finalizers on successful exit. An original body defect or interruption retains precedence after releases.

The data shape is a list of finalizers and a list of Result failures. Resource ownership remains the existing scope handler. No new runtime node or lifecycle API is required.

The baseline regression run failed with missing close events in both runners and missing older finalizers after typed release failure. A body defect was replaced by that release failure. resource-red.log retains the assertion differences. The fixed core run passed 196 tests and typecheck. resource-review.md records independent runtime probes, including asynchronous fiber cleanup.

The initial repair allowed an unhandled effect raised inside a swallowed cleanup failure to disappear. The runner now remembers its first boundary error and reports it after unwind. A pre-existing generator regression also demonstrated the newly released captured resource. Its expected events changed from only outer finally to release followed by outer finally. This repairs the leak rather than weakening the error assertion.

No-comments flagged the added TypeScript suppression in the untyped sync boundary test. The test now uses Reflect.apply to intentionally enter that runtime boundary without a compiler suppression. No application comments were added. The resource handler retains its existing trusted dependent-answer boundary.
