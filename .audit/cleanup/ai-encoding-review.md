# A1 result-encoding repair: independent read-only verdict

**PASS for the immediate encoding-defect diagnostic and no-replay contract** on branch `cleanup/ai-turns`, HEAD `086947dd942b5aa6b6d5d4a2f49c3a5ee6a51c62`, against base `800c86e7bdf28b12d13a1bb54a8beacdbcf46eb5`. This reviewer made no source edits or commits.

The local `packages/ai/src/generate.ts` diff moves `JSON.stringify(value) ?? "null"` into the existing `Kyoot.gen(...).pipe(Fail.run)` boundary around the tool action. A thrown `toJSON()` is therefore a `Defect` in the same outcome branch as an action defect. That branch stores and reports `UnknownToolOutcome` immediately, with the original error as `cause`. The retained unknown state rejects later execution without calling the action again. An independent Node stdin probe checked both attempts: first and second returned `Fail(UnknownToolOutcome)` with the same original cause; the action count remained one after each attempt and no partial messages were published. The new `turn-repair.test.ts` regression asserts the same behavior.

Existing exact receipt tests still pass: typed tool failure becomes `error: {"_tag":"Boom"}` in the next model request; a void success becomes the string receipt `"null"`. The serializer fallback for `undefined` remains in the success path. `pnpm -F @kyoot/ai test`: 72/72 passed. `pnpm -F @kyoot/ai typecheck`: passed. `git diff --check 800c86e -- packages/ai`: passed.

No-comments review scoped to `git diff 800c86e -- packages/ai`, including working tree: no added source comments or lint/TypeScript suppressions, no `MUST KILL` flags, deletion count 0, restored comments 0, reruns 0, architect sketch/fixes/encoding offers/encodings/unenforced constraints/open work: none. The sole source comment found by scoped search is unchanged at `packages/ai/src/sse.ts:7`; it describes an external SSE CRLF chunk boundary and lies outside the diff. The requested comment-sicko subagent could not be spawned because the agent thread limit was reached, so this is a manual read-only application of its reference rather than a subagent report.

Snapshot SHA-256 values at verification:

| File                                   | SHA-256                                                            |
| -------------------------------------- | ------------------------------------------------------------------ |
| `packages/ai/src/generate.ts`          | `3dc3a8cb438cb75fc72bc9449013ad8f0034a341dd4ff78875e256cd126ab309` |
| `packages/ai/test/turn-repair.test.ts` | `499197d0f8fa1f4d0a5f69c5768fa294f2614cc729aecc0f7527371ee09624e4` |
| `packages/ai/test/ai.test.ts`          | `c385c3eb7a051094ee0cacce26715f6b45e60bbb1127955fefadef687c54117a` |
| `packages/ai/src/turn.ts`              | `e1018430e9d0d458bf6906eb8c3400ceeebbb6eac89b3b3638b2d2b3d8586611` |
| `packages/ai/test/providers.test.ts`   | `fdec0a0bd868ce94b0d12eb3cac7384b8bd7c84585290eedcbc80ce74b6a8b16` |
