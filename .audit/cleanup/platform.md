# Platform cleanup

Owner scope is A2, A9, and A10 in `packages/platform`. Baseline is `421ad78f5c3f4be16ab7b629879c2ecddb78570f`. Full persistence and crash recovery are outside this work.

throughput checkpoint: three findings, one platform owner, retained real-process and filesystem regressions.

## Progress

- [x] Ground the command and filesystem handlers.
- [x] Reproduce each defect before changing implementation.
- [x] Sketch two output-policy alternatives before changing the API.
- [x] Agree on a signature. The coordinator accepted a 1 MiB per-stream default.
- [ ] Implement the selected contracts.
- [ ] Verify the retained regressions, package checks, formatting, and diff.
- [ ] Apply deslop and commit only owned files.
- [ ] Scrap the design if evidence contradicts it. No contradiction observed yet.

## Grounding

`Command.run` emits an operation containing the executable, arguments, and options. `Node.command` handles that operation through `attempt`, which wraps a promise in `Async.fromPromise`. The runtime supplies an `AbortSignal` to this promise boundary. The current `attempt` discards it, and `execFile` consequently never receives cancellation. Runtime interruption rejects the fiber while the OS child keeps running.

`execFile` buffers stdout and stderr before producing `Command.Output`. The adapter currently inherits Node's implicit 1 MiB limit. Start failures and output overflow become `CommandError`; numeric process exit codes become successful `Output` values, including nonzero exit codes.

`Memory.fs` owns one file map and one directory set for each handled computation. Rename normalizes paths, verifies the destination parent, and then moves entries directly. It has no descendant or destination-type checks before mutation. `Node.fs` delegates rename to the real filesystem and maps OS errors to `FsError`.

## Output policy design

The architect grounding, sketch, and red-flag comparison were completed sequentially because the coordinator explicitly reserved the available agent slots. This comparison has one model's judgment, not an independent design panel.

### Candidate A

Keep buffered results and let callers choose a finite byte allowance per stream.

```ts
interface Options {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly stdin?: string;
  readonly maxBuffer?: number;
}

Command.run(process.execPath, ["-e", script], { maxBuffer: 2 * 1024 * 1024 });
```

The Node adapter supplies `maxBuffer: op.maxBuffer ?? 1024 * 1024` to `execFile`. It rejects allowances that are not nonnegative safe integers. Zero allows empty output. A limit applies independently to stdout and stderr and counts UTF-8 bytes. Overflow terminates the child and returns `CommandError`. Callers retain the current `Output` shape.

### Candidate B

Replace buffered output with stream ownership and a separate exit result.

```ts
interface RunningCommand {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly exit: Promise<number>;
}

Command.start(process.execPath, ["-e", script]): Kyoot<RunningCommand, CommandRow>;
```

Consumers drain both streams, impose their own retention policies, and own cancellation until exit. This supports large output without retaining it, but introduces a second execution path, asynchronous resources escaping the effect operation, and stream lifecycle responsibilities for every consumer. It also leaves buffered callers requiring an additional collector.

### Selection

Select Candidate A. It hides process buffering and cancellation behind the existing operation, adds one ordinary caller option, and avoids two public ways to execute a process. The explicit default is 1,048,576 bytes for each stream. This preserves the existing default behavior while making larger bounded output supported and documented. Maintainers can review the policy without consulting Node's undocumented inherited default in this adapter. Streaming remains a separate future API decision.

The organizing data shape remains `Command.Op extends Command.Options` with a single allowance. Cancellation remains the runtime's `AbortSignal`, rather than a new option or mutable cancellation flag. These choices follow Model the Domain and Type System Discipline. The retained tests follow Test Behavior, Not Implementation by observing a real child's delayed write and comparing rename refusals to a real directory.

## Red evidence

Run `pnpm -F @kyoot/platform test` before implementation changes. The retained tests produced `tests 27`, `pass 17`, and `fail 10`.

A2 failed after the actual child wrote its readiness file and the runtime rejected its interrupted fiber.

```text
command: interrupt stops a ready child before its delayed side effect
AssertionError [ERR_ASSERTION]: interrupted child must not perform its delayed write
true !== false
actual: true
expected: false
```

A9's smaller limit was ignored on both streams. Each UTF-8 probe emitted 66 bytes with `maxBuffer: 64`, but returned success.

```text
command: stdout respects a smaller byte bound
command: stderr respects a smaller byte bound
AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
assert.ok(!result.ok && result.cause._tag === "Fail")
actual: false
expected: true
```

A9's larger allowance was also ignored on both streams. Each child emitted 1,048,577 bytes with `maxBuffer: 2 * 1024 * 1024`.

```text
command: stdout accepts larger output with a larger bounded allowance
{ _tag: 'CommandError', message: 'stdout maxBuffer length exceeded' }
command: stderr accepts larger output with a larger bounded allowance
{ _tag: 'CommandError', message: 'stderr maxBuffer length exceeded' }
```

A10's Node operations refused both direct and normalized descendant destinations, while memory returned success.

```text
rename refuses a directory descendant /d/sub/moved without changing the tree
rename refuses a directory descendant /d/sub/../sub/moved without changing the tree
AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
assert.ok(!memory.result.ok && memory.result.cause._tag === "Fail")
actual: false
expected: true
```

The related rename checks narrowly exposed the same missing preflight mechanism. File over directory, directory over file, and directory over a nonempty directory all refused in Node but succeeded in memory. The three retained tests failed at `assert.ok(!memory.ok && memory.cause._tag === "Fail")`. These cases belong in this fix because they protect the same pre-mutation boundary. File and directory self-renames already passed and remain covered.

An initial test draft incorrectly called `Kyoot.runFiber`; the repository exports `runFiber` separately. The retained test imports the actual public function. Only the corrected reproduction above is defect evidence.

## Green evidence

Pending implementation and package validation.
