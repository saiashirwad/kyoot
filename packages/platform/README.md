# @kyoot/platform

Filesystems and commands as Kyoot effects. Requires Node 24+ and TypeScript 7.0.2. The Node handler uses Node's filesystem and child-process APIs; the memory handler supports deterministic tests.

```ts
import { Fail, Kyoot } from "kyoot";
import { FileSystem, Memory } from "@kyoot/platform";

const program = Kyoot.gen(function* () {
  yield* FileSystem.writeFile("/report.txt", "hello");
  return yield* FileSystem.readFile("/report.txt");
});
const result = program.pipe(Memory.fs(), Fail.orThrow, Kyoot.runSync);
// ["hello", { "/report.txt": "hello" }]
```

For live I/O, import `* as Node from "@kyoot/platform/node"` and use `Node.fs`, `Node.command`, or `Node.provide` for both. Finish with `Fail.orThrow, Kyoot.runPromise`.

## Filesystems

`FileSystem` provides `readFile`, `writeFile`, `appendFile`, `readDir`, `stat`, `exists`, `mkdir`, `remove`, and `rename`. Each operation declares `fs` and `fail: FsError`. Errors carry the operation, path, message, and code: `NotFound`, `AlreadyExists`, `PermissionDenied`, `NotADirectory`, `IsADirectory`, `NotEmpty`, or `Other`.

`Memory.fs(initial)` creates fresh state for each run and returns `[value, files]`. File size counts UTF-8 bytes. Parents must exist, file/directory conflicts fail, non-recursive removal rejects a non-empty directory, and rename checks source and target types.

`FileSystem.handle(table)` requires one entry per operation. Each entry receives that operation's payload and a continuation with its exact answer type. It is stateless; use the memory handler or trusted internal machinery when implementing a stateful runtime. Return expected errors with `resume.with(Fail.fail(error))`, so application catches around the operation see them.

`FileSystem.intercept(table)` accepts a partial table with matching payload and answer types. Omitted operations pass through:

```ts
const cached = FileSystem.intercept({
  readFile: (op, next) => (op.path === "/cached.txt" ? Kyoot.succeed("cached") : next(op)),
});
```

`unsafeIntercept` exposes the raw family callback for trusted code. Its answer is uncorrelated; prefer the safe table API in applications.

## Commands

`Command.run(command, args, options)` accepts `cwd`, `env`, `stdin`, and `maxOutputBytes`. It returns `{ code, signal, stdout, stderr }`. A normal exit has a numeric code and null signal, including nonzero exits. Signal termination has a null code and the signal name.

The default output limit is 1 MiB across stdout and stderr combined, counted in UTF-8 bytes. The limit must be a non-negative safe integer. Failure to start, an invalid limit, or output beyond the limit produces a typed `CommandError`. The handler returns these failures through `resume.with`, where application catches can see them.

On cancellation, the Node handler sends SIGTERM to the direct child and awaits its close event. It does not terminate the child's descendants or escalate to SIGKILL. A child that ignores SIGTERM can keep cancellation or output-limit cleanup waiting indefinitely.

## Path policy limits

The [interception example](examples/intercept.ts) checks absolute POSIX paths, resolves `..`, rejects ambiguous backslashes and leading `//`, and checks both paths in a rename. A raw prefix test is insufficient: `/work-other` and `/work/../outside` must not pass a `/work` policy.

This is a lexical policy. Symlinks can point outside the root, and paths can change between checking and use. Memory resolves relative paths against `/`; Node uses its working directory. Windows interprets separators and network paths differently. Normalize paths against your chosen base before interception, and use operating-system isolation when access must be confined.

`pnpm examples` runs the memory example. The live command example, [loc.ts](examples/loc.ts), runs only when invoked explicitly.
