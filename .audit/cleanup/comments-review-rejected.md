# Kyoot final source/test comment audit

Read-only audit. The two trees were treated as one final stack scope.

## Exact inputs

- `/Users/texoport/code/kyoot-continuation-contract`: baseline `421ad78f5c3f4be16ab7b629879c2ecddb78570f`, HEAD `3f0b7b2751834b0283ef1234e471baecc1dda23c`; the source/test diff includes the current working-tree Cfix. It spans 43 source/test files; SHA-256 of the scoped unified diff: `63e7e2eca7227e1d5d3d4f508309b6fb151653f4557a368269bbbffff9d3699f`.
- `/Users/texoport/code/kyoot-turns-cleanup`: baseline `800c86e7bdf28b12d13a1bb54a8beacdbcf46eb5`, HEAD `d44d282a6ea2767faad4f219e3f7bdb2024cf782`; AI source/test diff spans 8 files; SHA-256 of the scoped unified diff: `824c5a83356844aecf525199e37a21726f1bca96b0b2505c74aa3abf088eb423`.

## Findings and counts

- 8 explanatory `@ts-expect-error` comments added in the first tree; none added in the AI tree. Their messages are the only newly added comments in the scoped source/test diffs. Delete the explanatory text while retaining the TypeScript directives, which make each negative type assertion executable.
- 8 `MUST KILL` flags, all test-site directives in `packages/kyoot/test/continuation-contract.test-d.ts` and `packages/kyoot/test/contracts.test.ts`: `resume.with` nested-row compatibility; `resume.with` answer compatibility; raw-key `resume.with` effect restriction; aborting-operation resume; checked-answer extraction by raw-key handler; incompatible-operation handler answer; undefined payload narrowing; literal resume answer extraction. These negative assertions guard the corresponding compile-time contracts; encode them through type-level assertions if removing the directives.
- 1 old narration comment was already removed in the scoped diff (`packages/kyoot/test/generator.test.ts`: replacement halts the machine before cleanup). Its deletion is appropriate because the assertion immediately below records the observable behavior.
- Keep count: 8 `@ts-expect-error` compiler directives as negative type tests; no prose comments qualify for keeping. No comments were changed by this audit.
- Constraints needing encoding: the eight negative assertions already encode the listed compile-time constraints. No additional undocumented production constraint surfaced in the scoped comment diff.

No source or test files were edited and no commits were made.
