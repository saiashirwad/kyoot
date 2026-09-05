import { posix } from "node:path";
import { Fail, Kyoot, Log } from "kyoot";
import type { Kyoot as Program } from "kyoot";
import { FileSystem, Memory } from "@kyoot/platform";

type FsRow = { fs: FileSystem.Op; fail: FileSystem.FsError };
const auditOp = <O extends FileSystem.Op, A>(op: O, next: (op: O) => Program<A, FsRow>) =>
  Log.info(`${op.kind} ${op.path}`).flatMap(() => next(op));
const audit = FileSystem.intercept({
  readFile: auditOp,
  writeFile: auditOp,
  appendFile: auditOp,
  readDir: auditOp,
  stat: auditOp,
  exists: auditOp,
  mkdir: auditOp,
  remove: auditOp,
  rename: auditOp,
});

// A path posix.resolve and the handler read the same way: absolute, no backslash separators,
// no leading "//", which Windows reads as a UNC share.
const plainPosix = (path: string) =>
  posix.isAbsolute(path) && !path.startsWith("//") && !path.includes("\\");

// Resolve before comparing, and check every path the op carries — a prefix test on op.path
// alone lets through "/work-other/x", a sibling of the root, "/work/../etc/passwd", which
// resolves out of it, and any rename destination.
const confine = (dir: string) => {
  if (!plainPosix(dir)) throw new Error(`confine needs an absolute POSIX root, got ${dir}`);
  const root = posix.resolve(dir);
  const inside = (path: string) => {
    if (!plainPosix(path)) return false;
    const resolved = posix.resolve(path);
    return resolved === root || resolved.startsWith(root === "/" ? "/" : `${root}/`);
  };
  const check = <O extends FileSystem.Op, A>(op: O, next: (op: O) => Program<A, FsRow>) => {
    const denied = !inside(op.path)
      ? op.path
      : op.kind === "rename" && !inside(op.to)
        ? op.to
        : null;
    return denied === null
      ? next(op)
      : Fail.fail(new FileSystem.FsError(op.kind, denied, "PermissionDenied", `not under ${root}`));
  };
  return FileSystem.intercept({
    readFile: check,
    writeFile: check,
    appendFile: check,
    readDir: check,
    stat: check,
    exists: check,
    mkdir: check,
    remove: check,
    rename: check,
  });
};

const skip = (op: FileSystem.Op) => Log.warn(`skipped ${op.kind} ${op.path}`);
const dryRun = FileSystem.intercept({
  writeFile: skip,
  appendFile: skip,
  mkdir: skip,
  remove: skip,
  rename: skip,
});

const code = Fail.catchTag("FsError", (e: FileSystem.FsError) => Kyoot.succeed(e.code));

const program = Kyoot.gen(function* () {
  yield* FileSystem.writeFile("/work/report.txt", "draft");
  const listing = yield* FileSystem.readDir("/work");
  const sibling = yield* FileSystem.readFile("/work-other/notes.txt").pipe(code);
  const traversal = yield* FileSystem.readFile("/work/../etc/passwd").pipe(code);
  const relative = yield* FileSystem.readFile("work/old.txt").pipe(code);
  const backslash = yield* FileSystem.readFile("/work/sub\\..\\..\\etc\\passwd").pipe(code);
  const moved = yield* FileSystem.rename("/work/old.txt", "/etc/passwd").pipe(code);
  return { listing, sibling, traversal, relative, backslash, moved };
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
