# Final normalized source/test comment audit

Read-only comment-sicko review of the tracked TypeScript diff in `/Users/texoport/code/kyoot-cleanup` against `421ad78f5c3f4be16ab7b629879c2ecddb78570f`, including the current uncommitted continuation repair, and the eight `packages/ai` TypeScript diff files in `/Users/texoport/code/kyoot-turns-cleanup` against `800c86e7bdf28b12d13a1bb54a8beacdbcf46eb5`. Untracked files and non-TypeScript files were outside this assigned scope. No repository file was edited or committed.

## Disposition

- **Added comment lines:** 105 in the Kyoot diff, all `// @ts-expect-error ...` directives on negative compiler assertions in test fixtures; 0 in the AI diff. There are no added implementation comments, `@ts-ignore`, lint suppressions, or formatting suppressions in scope.
- **Removed comment lines already in the Kyoot diff:** 2. One narration line was deleted from `packages/kyoot/test/generator.test.ts`. An old `fork: "share"` negative test directive in `packages/kyoot/test/types.test-d.ts` was replaced by a `fork: "copy"` negative test directive as the API contract changed. The AI diff removes 0 comment lines.
- **Additional deletion count recommended:** 0. **MUST KILL count:** 0. **Restored comments:** 0. **Skips:** untracked and non-TypeScript files, as specified by the scope.

| Added negative assertion fixture                      | Directives |
| ----------------------------------------------------- | ---------: |
| `packages/kyoot/test/continuation-contract.test-d.ts` |         31 |
| `packages/kyoot/test/contract-repair.test-d.ts`       |         41 |
| `packages/kyoot/test/contracts.test-d.ts`             |         14 |
| `packages/kyoot/test/served.test-d.ts`                |          6 |
| `packages/kyoot/test/types.test-d.ts`                 |          1 |
| `packages/platform/test/fs.test-d.ts`                 |         10 |
| `packages/registry/test/types.test-d.ts`              |          2 |
| **Total**                                             |    **105** |

The new two directives at `continuation-contract.test-d.ts:186` and `:199` assert that a union continuation cannot be narrowed to its string-answer branch by annotation. Removing only those directives in an isolated copy caused TS2322 at lines 187 and 200, respectively, with diagnostics showing incompatible number and string answer contracts. The unchanged `pnpm --filter kyoot typecheck` passes. The earlier corrected audit verified the previous 114 current test directives by stripping them in an isolated copy; the current inventory is 116 (those 114 plus the two checked here). These directives are negative type tests: TypeScript would reject an unused directive with TS2578 if its invalid example became accepted. They are not implementation suppressions.

## Reproducibility hashes

- Kyoot cleanup HEAD: `df093065096b7c2714eed0ccfabb71f9cca8cc23`; SHA-256 of the tracked `.ts`/`.tsx` diff against `421ad78` including current working-tree edits: `b13d19dae92c8e6f3df8b545073509e0cd17ebffeec7acb9d19c23a01edc5b9d` (46 files).
- Current `packages/kyoot/src/core.ts` SHA-256: `4e8233417a3d78bbd7bc50f6f588e4e8a992ea127aebe05ad0e71e824f63ef24`.
- Current `packages/kyoot/test/continuation-contract.test-d.ts` SHA-256: `119cee094ae61832a3e070d30028d26ef023abcd8012c60050955bb59e8a42b3`.
- AI turns cleanup HEAD: `d44d282a6ea2767faad4f219e3f7bdb2024cf782`; SHA-256 of its tracked `packages/ai` `.ts`/`.tsx` diff against `800c86e`: `47df059cd121731ad17037e016d1b3cc7c6feb1f90004a010f219b48bd7b35f9` (8 files).
- Current `packages/ai/src/turn.ts` SHA-256: `e1018430e9d0d458bf6906eb8c3400ceeebbb6eac89b3b3638b2d2b3d8586611`.
