import assert from "node:assert/strict";
import { posix } from "node:path";
import { test } from "node:test";
import { Fail, Kyoot, Log } from "kyoot";
import { FileSystem, Memory } from "@kyoot/platform";
import * as Node from "@kyoot/platform/node";

const confine = (dir: string) => {
  if (!posix.isAbsolute(dir)) throw new Error(`confine needs an absolute root, got ${dir}`);
  const root = posix.resolve(dir);
  const inside = (path: string) => {
    if (!posix.isAbsolute(path)) return false;
    const resolved = posix.resolve(path);
    return resolved === root || resolved.startsWith(root === "/" ? "/" : `${root}/`);
  };
  return FileSystem.intercept((op, next) => {
    const outside = !inside(op.path)
      ? op.path
      : op.kind === "rename" && !inside(op.to)
        ? op.to
        : null;
    if (outside === null) return next(op);
    const why = posix.isAbsolute(outside) ? `outside ${root}` : `relative to no known root`;
    return Fail.fail(new FileSystem.FsError(op.kind, outside, "PermissionDenied", why));
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

test("confine rejects a sibling of the root, and a traversal out of it", () => {
  const program = Kyoot.gen(function* () {
    const root = yield* FileSystem.readDir("/work");
    const child = yield* FileSystem.readFile("/work/old.txt").pipe(code);
    const sibling = yield* FileSystem.readFile("/work-other/notes.txt").pipe(code);
    const traversal = yield* FileSystem.readFile("/work/../etc/passwd").pipe(code);
    const backOut = yield* FileSystem.readFile("/work/sub/../../etc/passwd").pipe(code);
    return { root, child, sibling, traversal, backOut };
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
    root: ["old.txt"],
    child: "kept",
    sibling: "PermissionDenied",
    traversal: "PermissionDenied",
    backOut: "PermissionDenied",
  });
});

test("confine checks the destination of a rename, not only the source", () => {
  const program = Kyoot.gen(function* () {
    const out = yield* FileSystem.rename("/work/secret.txt", "/etc/passwd").pipe(code);
    const traversal = yield* FileSystem.rename("/work/secret.txt", "/work/../leak.txt").pipe(code);
    const relative = yield* FileSystem.rename("/work/secret.txt", "work/leak.txt").pipe(code);
    const within = yield* FileSystem.rename("/work/secret.txt", "/work/moved.txt").pipe(code);
    return { out, traversal, relative, within };
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
    within: undefined,
  });
  assert.deepEqual(files, { "/work/moved.txt": "shh", "/etc/passwd": "root" });
});

test("confine takes an absolute root and rejects relative paths, which the handlers disagree on", () => {
  assert.throws(() => confine("work"), /absolute root/);

  const write = FileSystem.writeFile("work/leak.txt", "x");

  // Memory.fs resolves a relative path against "/", so unchecked it lands inside the root.
  const [, memory] = Kyoot.runSync(write.pipe(Memory.fs({ "/work/old.txt": "" }), Fail.orThrow));
  assert.deepEqual(memory, { "/work/old.txt": "", "/work/leak.txt": "x" });

  // Node.fs resolves it against the process's cwd, which is not under "/work" at all.
  const nodePath = posix.resolve(process.cwd(), "work/leak.txt");
  assert.equal(nodePath.startsWith("/work/"), false);

  // One base cannot stand for both, so confine refuses the path instead of picking one.
  const [denied, files] = Kyoot.runSync(
    write.pipe(code, confine("/work"), Memory.fs({ "/work/old.txt": "" }), Fail.orThrow),
  );
  assert.equal(denied, "PermissionDenied");
  assert.deepEqual(files, { "/work/old.txt": "" });
});
