# Registry ownership

A use execution owns its registration until it synchronously delivers the handle. A Resource guard removes an undelivered entry on interruption or defect and awaits deactivation. The entry is allocated inside the execution rather than at construction of the reusable program. After delivery, the registry owns it until remove or dispose.

The entry has an explicit registered flag. Removal clears that flag before any transition, so dependency notifications cannot reactivate a withdrawn component. Handle removal, acquisition cleanup, and disposal share the same idempotent removal path. Cleanup remains visible in the entry's existing transition promise until it finishes. No detached abort listener owns resources.

The rejected alternative returned a handle before setup completed and required a separate readiness API. The selected guard keeps use's existing await-ready contract and uses the runtime's existing masked finalizer execution.

The red regressions show a missing partial down event when the interrupted caller settles, and only one activation when evaluating one use program twice. The green regressions additionally replace a cancelled provider and verify the consumer follows only the replacement. Full persistence and crash recovery are outside this contract.
