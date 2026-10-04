# Registry A8 independent review

Verdict: **VERIFIED** against `47d985e299a80bd0e2049571eeb4e8643bd8eae7`.

Reviewed current `packages/registry/src/index.ts` diff SHA-256: `706dae0e22131fec0b3299c1948b37a3b2719e52681584c813b725676f1d308e` (`git diff 47d985e -- packages/registry/src/index.ts | shasum -a 256`). The new, untracked `packages/registry/test/cancellation.test.ts` SHA-256 is `af8ff0891c54978b68fb2f59356776e3a4ade0e4acf0464c941324cba7755789`. These hashes identify the reviewed version, including the later `this` binding revision.

I read `registry.md`, the red, green, and workspace logs, the source and test diff, and the `Resource`, `Async`, fiber, and unwind implementations. The red log shows both new regressions failing before the fix; the green log records 23 passing registry tests. I independently reran `pnpm --filter @kyoot/registry test` (23/23 passed) and `pnpm --filter @kyoot/registry typecheck` (exit 0). The latter pnpm invocation emitted transient bin creation warnings while other workspace work was active, but `tsc -p tsconfig.json` ran and succeeded.

Evidence by boundary:

- **Cancellation during setup:** The new regression interrupts a provider after it acquires a partial resource and binding but before its async setup completes. Its caller rejects only after the partial resource's down event. The test then resolves the old setup promise and confirms the old provider does not land.
- **Promise resolved before interpreter continuation:** An independent in-memory Node probe resolved the setup gate and called `fiber.interrupt()` synchronously before the promise reaction resumed the interpreter. No post-setup acquisition occurred, and the use fiber rejected with `InterruptedError`. The runtime increments its generation on abort, discarding the stale fulfillment reaction.
- **Cleanup awaited at caller settlement:** In that probe, the provider release awaited a separate gate. After interruption, its release had started and the caller promise was still pending. Resolving the release gate produced the down event before the caller rejected. `Resource.run` finalization runs through the interpreter's masked interrupt path.
- **Partial bindings removed and notifications cannot resurrect:** The cancellation regression replaces the same tag after the cancelled provider settles. Only the replacement activates the consumer. `remove` clears `registered` before awaiting the transition, and `refresh` refuses to retarget an unregistered entry even if a queued notification reaches it.
- **Repeated executions and idempotency:** The new regression evaluates one `use` program twice, obtains independent live handles, and removes each separately. Existing registry tests cover repeated `remove`, in-flight `dispose`, and dependency teardown. The independent probe also called `dispose` twice, reused the registry for a new component, and removed its handle twice; all assertions passed.

The changed source and new cancellation test contain no comments or TypeScript/lint suppressions to audit. The diff introduces no `any` cast, extra defensive catch, or broad restructuring. The `this` binding is somewhat conspicuous, but gives the deferred generator the registry instance and passes the current typecheck; I found no behavior defect from it.

No proved issues in the reviewed registry scope. This verdict does not cover unrelated workspace changes.
