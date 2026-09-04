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

const confine = (dir: string) => {
  if (!posix.isAbsolute(dir) || dir.includes("\\"))
    throw new Error(`confine needs an absolute POSIX root, got ${dir}`);
  const root = posix.resolve(dir);
  const inside = (path: string) => {
    if (path.includes("\\") || !posix.isAbsolute(path)) return false;
    const resolved = posix.resolve(path);
    return resolved === root || resolved.startsWith(root === "/" ? "/" : `${root}/`);
  };
  const why = (path: string) =>
    path.includes("\\")
      ? "backslashes are not POSIX separators"
      : posix.isAbsolute(path)
        ? `outside ${root}`
        : "relative to no known root";
  return FileSystem.intercept((op, next) => {
    const outside = !inside(op.path)
      ? op.path
      : op.kind === "rename" && !inside(op.to)
        ? op.to
        : null;
    return outside === null
      ? next(op)
      : Fail.fail(new FileSystem.FsError(op.kind, outside, "PermissionDenied", why(outside)));
  });
};

const dryRun = FileSystem.intercept((op, next) =>
  writes.has(op.kind) ? Log.warn(`skipped ${op.kind} ${op.path}`) : next(op),
);

program.pipe(audit, confine("/work"), dryRun, Node.fs);
```

`confine` resolves before it compares, because `op.path.startsWith(root)` is not a path test: with `root = "/work"` it accepts `/work-other/x`, a sibling directory, and `/work/../outside`, which the handler resolves out of the root. It also checks every path the op carries — `rename` writes to `op.to`, so a source check alone lets `FileSystem.rename("/work/secret.txt", "/etc/passwd")` through.

Absolute paths only, on both ends. A relative path means nothing until something resolves it, and the handlers disagree on the base: `Memory.fs` resolves against `/`, so `work/leak.txt` is `/work/leak.txt` and inside the root; `Node.fs` resolves against the process's cwd, so the same string means `/work/leak.txt` when cwd is `/`, `/srv/app/work/leak.txt` when cwd is `/srv/app`, and another path under another cwd. A check that picks one base decides for a handler that will use the other, so `confine` refuses a relative `op.path` or `op.to` instead, and takes an absolute root. Resolve paths against your chosen base before they reach the intercept.

POSIX paths only, too. `posix.resolve` reads `\` as an ordinary character in a name, so `/work/sub\..\..\etc\passwd` is one file called `sub\..\..\etc\passwd` inside the root — but `Node.fs` on Windows reads those as separators and lands on `\etc\passwd`, outside it. Rather than resolve a path one way and hand it to a handler that reads it another, `confine` rejects any `op.path` or `op.to` holding a backslash, and takes a backslash-free root. A policy for Windows paths is the same shape against `path.win32`.

That is a policy, not a jail. It is lexical: it does not follow symlinks or hard links, so a link under the root that points outside it still resolves outside once the handler opens it, and nothing here stops a path from changing between the check and the op. A real boundary is the operating system's — a container, a `chroot`, a user with no rights outside the tree — and this intercept is how you state the policy above it.

`examples/intercept.ts` runs these against `Memory.fs` and shows the log, the `PermissionDenied` the program caught for a sibling path, a traversal, and a rename out of the root, and the files a dry run did not write. In a service-object design each of these means wrapping every method; here they are a few lines each and know nothing about each other.

A handler for another runtime is the same three functions against that runtime's APIs. The effects and the programs written against them don't change.

`test/fs.test.ts` runs one program against `Memory.fs` and `Node.fs` and expects the same answer.
