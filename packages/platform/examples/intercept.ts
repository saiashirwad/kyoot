import { posix } from "node:path";
import { Fail, Kyoot, Log } from "kyoot";
import { FileSystem, Memory } from "@kyoot/platform";

const audit = FileSystem.intercept((op, next) =>
  Log.info(`${op.kind} ${op.path}`).flatMap(() => next(op)),
);

// A prefix test is not a path boundary: both "/work-other/x".startsWith("/work") and
// "/work/../etc/passwd".startsWith("/work") are true. Resolve the path first, then require
// it to be the root itself or to sit under `root + "/"`, and check every path the op
// carries — a rename also writes to `op.to`.
const confine = (dir: string) => {
  const root = posix.resolve("/", dir);
  const inside = (path: string) => {
    const resolved = posix.resolve("/", path);
    return resolved === root || resolved.startsWith(root === "/" ? "/" : `${root}/`);
  };
  return FileSystem.intercept((op, next) => {
    const outside = !inside(op.path)
      ? op.path
      : op.kind === "rename" && !inside(op.to)
        ? op.to
        : null;
    return outside === null
      ? next(op)
      : Fail.fail(new FileSystem.FsError(op.kind, outside, "PermissionDenied", `outside ${root}`));
  });
};

const writes = new Set(["writeFile", "appendFile", "mkdir", "remove", "rename"]);

const dryRun = FileSystem.intercept((op, next) =>
  writes.has(op.kind) ? Log.warn(`skipped ${op.kind} ${op.path}`) : next(op),
);

const code = Fail.catchTag("FsError", (e: FileSystem.FsError) => Kyoot.succeed(e.code));

const program = Kyoot.gen(function* () {
  yield* FileSystem.writeFile("/work/report.txt", "draft");
  const listing = yield* FileSystem.readDir("/work");
  const sibling = yield* FileSystem.readFile("/work-other/notes.txt").pipe(code);
  const traversal = yield* FileSystem.readFile("/work/../etc/passwd").pipe(code);
  const moved = yield* FileSystem.rename("/work/old.txt", "/etc/passwd").pipe(code);
  return { listing, sibling, traversal, moved };
});

const [result, files] = Kyoot.runSync(
  program.pipe(
    audit,
    confine("/work"),
    dryRun,
    Memory.fs({ "/work/old.txt": "", "/etc/passwd": "root:x:0:0" }),
    Log.print,
    Fail.orThrow,
  ),
);
console.log(result, files);
