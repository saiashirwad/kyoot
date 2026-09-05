import assert from "node:assert/strict";
import { posix } from "node:path";
import { test } from "node:test";
import { Fail, Kyoot, Log } from "kyoot";
import { FileSystem, Memory } from "@kyoot/platform";
import * as Node from "@kyoot/platform/node";

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

const code = Fail.catchTag("FsError", (e: FileSystem.FsError) => Kyoot.succeed(e.code));

test("a failure lands at the op, where the program's own catch sees it", async () => {
  const program = FileSystem.readFile("/nope").pipe(
    Fail.catchTag("FsError", (e: FileSystem.FsError) => Kyoot.succeed(e.code)),
  );
  assert.equal(Kyoot.runSync(program.pipe(Memory.fs()))[0], "NotFound");
  assert.equal(await Kyoot.runPromise(program.pipe(Node.fs)), "NotFound");
});

test("handlers between the program and the file system see every op", () => {
  const audit = FileSystem.intercept((op, next) =>
    Log.info(`${op.kind} ${op.path}`).flatMap(() => next(op)),
  );
  const dryRun = FileSystem.intercept((op, next) =>
    op.kind === "writeFile" ? Log.warn(`skipped ${op.path}`) : next(op),
  );
  const program = Kyoot.gen(function* () {
    yield* FileSystem.writeFile("/work/new.txt", "x");
    const listing = yield* FileSystem.readDir("/work");
    const leaked = yield* FileSystem.readFile("/etc/passwd").pipe(code);
    return { listing, leaked };
  });
  const [[result, files], logs] = Kyoot.runSync(
    program.pipe(
      audit,
      confine("/work"),
      dryRun,
      Memory.fs({ "/work/old.txt": "", "/etc/passwd": "root" }),
      Log.collect,
      Fail.orThrow,
    ),
  );
  assert.deepEqual(result, { listing: ["old.txt"], leaked: "PermissionDenied" });
  assert.deepEqual(files, { "/work/old.txt": "", "/etc/passwd": "root" });
  assert.deepEqual(
    logs.map((l) => l.message),
    ["writeFile /work/new.txt", "skipped /work/new.txt", "readDir /work", "readFile /etc/passwd"],
  );
});

test("confine takes the paths a prefix test lets through", () => {
  const program = Kyoot.gen(function* () {
    const listing = yield* FileSystem.readDir("/work");
    const child = yield* FileSystem.readFile("/work/old.txt").pipe(code);
    const sibling = yield* FileSystem.readFile("/work-other/notes.txt").pipe(code);
    const traversal = yield* FileSystem.readFile("/work/../etc/passwd").pipe(code);
    const relative = yield* FileSystem.readFile("work/old.txt").pipe(code);
    const backslash = yield* FileSystem.readFile("/work/sub\\..\\..\\etc\\passwd").pipe(code);
    const unc = yield* FileSystem.readFile("//work/share/file").pipe(code);
    return { listing, child, sibling, traversal, relative, backslash, unc };
  });
  const [result] = Kyoot.runSync(
    program.pipe(
      confine("/work"),
      Memory.fs({
        "/work/old.txt": "kept",
        "/work-other/notes.txt": "sibling",
        "/etc/passwd": "root",
      }),
      Fail.orThrow,
    ),
  );
  assert.deepEqual(result, {
    listing: ["old.txt"],
    child: "kept",
    sibling: "PermissionDenied",
    traversal: "PermissionDenied",
    relative: "PermissionDenied",
    backslash: "PermissionDenied",
    unc: "PermissionDenied",
  });
});

test("confine checks the destination of a rename, and takes an absolute POSIX root", () => {
  assert.throws(() => confine("work"), /absolute POSIX root/);
  assert.throws(() => confine("/work\\sub"), /absolute POSIX root/);
  assert.throws(() => confine("//work"), /absolute POSIX root/);

  const program = Kyoot.gen(function* () {
    const out = yield* FileSystem.rename("/work/secret.txt", "/etc/passwd").pipe(code);
    const traversal = yield* FileSystem.rename("/work/secret.txt", "/work/../leak.txt").pipe(code);
    const relative = yield* FileSystem.rename("/work/secret.txt", "work/leak.txt").pipe(code);
    const backslash = yield* FileSystem.rename("/work/secret.txt", "/work\\leak.txt").pipe(code);
    const unc = yield* FileSystem.rename("/work/secret.txt", "//work/share/file").pipe(code);
    const within = yield* FileSystem.rename("/work/secret.txt", "/work/moved.txt").pipe(code);
    return { out, traversal, relative, backslash, unc, within };
  });
  const [result, files] = Kyoot.runSync(
    program.pipe(
      confine("/work"),
      Memory.fs({ "/work/secret.txt": "shh", "/etc/passwd": "root" }),
      Fail.orThrow,
    ),
  );
  assert.deepEqual(result, {
    out: "PermissionDenied",
    traversal: "PermissionDenied",
    relative: "PermissionDenied",
    backslash: "PermissionDenied",
    unc: "PermissionDenied",
    within: undefined,
  });
  assert.deepEqual(files, { "/work/moved.txt": "shh", "/etc/passwd": "root" });
});
