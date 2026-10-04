# Final corrected Kyoot source/test comment audit

Read-only audit using `comment-sicko.md`. Inputs: `/Users/texoport/code/kyoot-cleanup` at `df093065096b7c2714eed0ccfabb71f9cca8cc23` plus its current working-tree fixes, diffed against `421ad78f5c3f4be16ab7b629879c2ecddb78570f`; and `/Users/texoport/code/kyoot-turns-cleanup` at `d44d282a6ea2767faad4f219e3f7bdb2024cf782`, diffed against `800c86e7bdf28b12d13a1bb54a8beacdbcf46eb5`. The scan covered all tracked `.ts`/`.tsx` diff lines (46 files in the first tree, including a bench source and an audit repro; 8 AI files in the second). Untracked files were outside the diff.

## Finding

The first diff adds **103 comment lines**. Every one is a `// @ts-expect-error ...` negative compiler assertion in a test fixture; no standalone explanatory comment, source implementation suppression, `@ts-ignore`, `eslint-disable`, or `prettier-ignore` was added. The AI diff adds or removes no comments. The current working-tree fixes add eight optional-continuation assertions to the committed stack's 95: three earlier optional-key checks and five subsequent optional-row/variance checks.

| Test fixture in first diff                            | Added negative assertions |
| ----------------------------------------------------- | ------------------------: |
| `packages/kyoot/test/continuation-contract.test-d.ts` |                        29 |
| `packages/kyoot/test/contract-repair.test-d.ts`       |                        41 |
| `packages/kyoot/test/contracts.test-d.ts`             |                        14 |
| `packages/kyoot/test/served.test-d.ts`                |                         6 |
| `packages/kyoot/test/types.test-d.ts`                 |                         1 |
| `packages/platform/test/fs.test-d.ts`                 |                        10 |
| `packages/registry/test/types.test-d.ts`              |                         2 |
| **Total**                                             |                   **103** |

Two old comment lines are removed by the first diff: one standalone narration in `packages/kyoot/test/generator.test.ts` (appropriate deletion), and one old `@ts-expect-error` in `packages/kyoot/test/types.test-d.ts` whose rejected `fork: "share"` example was replaced by the added rejected `fork: "copy"` example as the fork-mode contract changed. The second removal is replacement of a test assertion, not deletion of a workaround.

**Deletion count recommended: 0 additional whole comment lines. MUST KILL: none.** Keep all 103 added compiler directives: removing one would make its fixture fail typechecking, while an accidentally accepted invalid program would make the directive itself fail with TS2578. The explanatory words after each directive are optional to TypeScript, so a strict style-only pass could trim 103 suffixes while retaining each directive. Those suffixes state which contract the negative fixture probes; there is no correctness reason to trim them. There are no implementation suppressions to reshape or mark `MUST KILL`.

## Independent compiler verification

The unchanged `kyoot`, `platform`, and `registry` package typechecks passed. In an isolated temporary copy of the first tree, I blanked all **114 current test** `@ts-expect-error` lines while keeping line numbers stable and reran the same TypeScript compiler. Diagnostics appeared on the next line for **all 114** sites: 102/102 Kyoot, 10/10 platform, 2/2 registry. The compiler emitted 121 diagnostics in total because some sites produced more than one error; there were no missing sites or diagnostics outside the asserted lines. This includes all 103 added directives. The temporary copy was discarded. No project source/test file was edited and no commit was made.
