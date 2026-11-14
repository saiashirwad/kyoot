import { posix } from "node:path";
import { Kyoot } from "kyoot";
import * as Fail from "kyoot/fail";
import * as Log from "kyoot/log";
import { FileSystem, Memory } from "@kyoot/platform";

const audit = FileSystem.intercept({
  writeFile: (p, next) => Log.info(`writeFile ${p.path}`).flatMap(() => next(p)),
  readDir: (p, next) => Log.info(`readDir ${p.path}`).flatMap(() => next(p)),
  readFile: (p, next) => Log.info(`readFile ${p.path}`).flatMap(() => next(p)),
});

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
  const deny = (op: FileSystem.Name, path: string) =>
    Fail.fail(new FileSystem.FsError(op, path, "PermissionDenied", `not under ${root}`));
  return FileSystem.intercept({
    readFile: (p, next) => (inside(p.path) ? next(p) : deny("readFile", p.path)),
    writeFile: (p, next) => (inside(p.path) ? next(p) : deny("writeFile", p.path)),
    appendFile: (p, next) => (inside(p.path) ? next(p) : deny("appendFile", p.path)),
    readDir: (p, next) => (inside(p.path) ? next(p) : deny("readDir", p.path)),
    stat: (p, next) => (inside(p.path) ? next(p) : deny("stat", p.path)),
    exists: (p, next) => (inside(p.path) ? next(p) : deny("exists", p.path)),
    mkdir: (p, next) => (inside(p.path) ? next(p) : deny("mkdir", p.path)),
    remove: (p, next) => (inside(p.path) ? next(p) : deny("remove", p.path)),
    rename: (p, next) =>
      !inside(p.path) ? deny("rename", p.path) : !inside(p.to) ? deny("rename", p.to) : next(p),
  });
};

const skip = (name: string) => (p: { path: string }) => Log.warn(`skipped ${name} ${p.path}`);

const dryRun = FileSystem.intercept({
  writeFile: skip("writeFile"),
  appendFile: skip("appendFile"),
  mkdir: skip("mkdir"),
  remove: skip("remove"),
  rename: skip("rename"),
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
