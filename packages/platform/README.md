# @kyoot/platform

The file system and processes as kyoot effects. A program says `FileSystem.readFile(path)`; which file system that is gets decided by the handler you pipe in.

```ts
import { Fail, Kyoot, Log } from "kyoot";
import { Command, FileSystem } from "@kyoot/platform";
import * as Node from "@kyoot/platform/node";

const program = Kyoot.gen(function* () {
  const { stdout } = yield* Command.run("git", ["ls-files"]);
  for (const file of stdout.trim().split("\n"))
    yield* FileSystem.appendFile("manifest.txt", `${file}\n`);
});

await program.pipe(Node.provide, Fail.orThrow, Kyoot.runPromise);
```

## Effects

- `FileSystem` — `readFile`, `writeFile`, `appendFile`, `readDir`, `stat`, `exists`, `mkdir`, `remove`, `rename`. Each puts `fs` and `fail: FsError` in the row. An `FsError` carries the op, the path, and a `code`: `NotFound`, `AlreadyExists`, `PermissionDenied`, `NotADirectory`, `IsADirectory`, `NotEmpty`, `Other`.
- `Command` — `run(command, args, { cwd, env, stdin })` returns `{ code, stdout, stderr }`. A non-zero exit is an output; a program that cannot start is a `CommandError`.

## Handlers

- `@kyoot/platform/node` — `Node.fs`, `Node.command`, and `Node.provide` for both. Works on Bun too, since Bun implements `node:fs` and `node:child_process`.
- `Memory.fs(initial)` — an in-memory file system. Returns `[result, files]` so a test can assert on what was written. It enforces the same rules as a real one: parents must exist, `mkdir` on an existing path fails, `remove` on a non-empty directory needs `recursive`.
- `FileSystem.handle` / `Command.handle` — build your own, or a fake for one test.

## Interception

Every call is a value passing through one point, so a policy over all file access is a handler. `intercept` sees the op and a `next` that performs it for the handlers outside; `handle` with `resume.with` hands the program a failure it can catch itself.

```ts
import { posix } from "node:path";

const writes = new Set(["writeFile", "appendFile", "mkdir", "remove", "rename"]);

const audit = FileSystem.intercept((op, next) =>
  Log.info(`${op.kind} ${op.path}`).flatMap(() => next(op)),
);

// A path posix.resolve and the handler will read the same way: not relative, no backslash
// separators, no leading "//", which Windows reads as a UNC share.
const plainPosix = (path: string) =>
  posix.isAbsolute(path) && !path.startsWith("//") && !path.includes("\\");

const confine = (dir: string) => {
  if (!plainPosix(dir)) throw new Error(`confine needs an absolute POSIX root, got ${dir}`);
  const root = posix.resolve(dir);
  const inside = (path: string) => {
    if (!plainPosix(path)) return false;
    const resolved = posix.resolve(path);
    return resolved === root || resolved.startsWith(root === "/" ? "/" : `${root}/`);
  };
  return FileSystem.intercept((op, next) => {
    const denied = !inside(op.path)
      ? op.path
      : op.kind === "rename" && !inside(op.to)
        ? op.to
        : null;
    return denied === null
      ? next(op)
      : Fail.fail(new FileSystem.FsError(op.kind, denied, "PermissionDenied", `not under ${root}`));
  });
};

const dryRun = FileSystem.intercept((op, next) =>
  writes.has(op.kind) ? Log.warn(`skipped ${op.kind} ${op.path}`) : next(op),
);

program.pipe(audit, confine("/work"), dryRun, Node.fs);
```

`confine` resolves before it compares, because `op.path.startsWith(root)` is not a path test: with `root = "/work"` it accepts `/work-other/x`, a sibling directory, and `/work/../outside`, which the handler resolves out of the root. It checks `op.to` as well, or `FileSystem.rename("/work/secret.txt", "/etc/passwd")` gets in on its source. It takes absolute POSIX paths and denies the rest, because a path the check and the handler read differently is worse than no path: `Memory.fs` resolves a relative path against `/` and `Node.fs` against the process's cwd, a backslash is an ordinary character to `posix.resolve` but a separator to `Node.fs` on Windows, and a leading `//` is a share there — `posix.resolve("//work/share/file")` is `/work/share/file`, inside the root, while Windows opens `\\work\share\file` on a host called `work`. Resolve paths against your own base before they reach the intercept.

That is a policy, not a jail. The check is lexical, so a symlink under the root still opens whatever it points at, and nothing here stops a path from changing between the check and the op. The boundary is the operating system's — a container, a `chroot`, a user with no rights outside the tree — and this intercept is how you state the policy above it.

`examples/intercept.ts` runs these against `Memory.fs` and shows the log, the caught `PermissionDenied`, and the files a dry run did not write. In a service-object design each of these means wrapping every method; here they are a few lines each and know nothing about each other.

A handler for another runtime is the same three functions against that runtime's APIs. The effects and the programs written against them don't change.

`test/fs.test.ts` runs one program against `Memory.fs` and `Node.fs` and expects the same answer.
