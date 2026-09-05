import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Fail, Kyoot } from "kyoot";
import { FileSystem, Memory } from "@kyoot/platform";
import * as Node from "@kyoot/platform/node";

const scenario = (root: string) =>
  Kyoot.gen(function* () {
    yield* FileSystem.mkdir(`${root}/a/b`, { recursive: true });
    yield* FileSystem.writeFile(`${root}/a/b/hello.txt`, "hello");
    yield* FileSystem.appendFile(`${root}/a/b/hello.txt`, " world");
    yield* FileSystem.rename(`${root}/a/b/hello.txt`, `${root}/a/hi.txt`);
    const text = yield* FileSystem.readFile(`${root}/a/hi.txt`);
    const { type, size } = yield* FileSystem.stat(`${root}/a/hi.txt`);
    const listing = yield* FileSystem.readDir(`${root}/a`);
    yield* FileSystem.remove(`${root}/a/b`);
    const removed = !(yield* FileSystem.exists(`${root}/a/b`));
    return { text, type, size, listing: listing.sort(), removed };
  });

const expected = {
  text: "hello world",
  type: "file",
  size: 11,
  listing: ["b", "hi.txt"],
  removed: true,
};

test("the same program runs against the in-memory file system", () => {
  const [result, files] = Kyoot.runSync(scenario("/tmp").pipe(Memory.fs(), Fail.orThrow));
  assert.deepEqual(result, expected);
  assert.deepEqual(files, { "/tmp/a/hi.txt": "hello world" });
});

test("and against the real one", async () => {
  const root = await fsp.mkdtemp(join(tmpdir(), "kyoot-"));
  try {
    const result = await Kyoot.runPromise(scenario(root).pipe(Node.fs, Fail.orThrow));
    assert.deepEqual(result, expected);
    assert.equal(await fsp.readFile(`${root}/a/hi.txt`, "utf8"), "hello world");
  } finally {
    await fsp.rm(root, { recursive: true });
  }
});

const seed = { "/d/inner.txt": "1", "/f.txt": "x" };

const caughtCode = <A>(k: Kyoot<A, { fs: FileSystem.Op; fail: FileSystem.FsError }>) =>
  k.pipe(Fail.catchTag("FsError", (error: FileSystem.FsError) => Kyoot.succeed(error.code)));

const code = (k: Kyoot<unknown, { fs: FileSystem.Op; fail: FileSystem.FsError }>) => {
  const r = Kyoot.runSync(k.pipe(Memory.fs(seed), Fail.run));
  return r.ok ? "ok" : r.cause._tag === "Fail" ? r.cause.error.code : "defect";
};

test("memory: errors carry codes", () => {
  assert.equal(code(FileSystem.readFile("/nope")), "NotFound");
  assert.equal(code(FileSystem.readFile("/d")), "IsADirectory");
  assert.equal(code(FileSystem.readDir("/f.txt")), "NotADirectory");
  assert.equal(code(FileSystem.mkdir("/d")), "AlreadyExists");
  assert.equal(code(FileSystem.mkdir("/x/y")), "NotFound");
  assert.equal(code(FileSystem.writeFile("/x/y.txt", "")), "NotFound");
  assert.equal(code(FileSystem.remove("/d")), "NotEmpty");
  assert.equal(code(FileSystem.remove("/d", { recursive: true })), "ok");
  assert.equal(code(FileSystem.rename("/d", "/e")), "ok");
});

test("memory: recursive mkdir does not replace a file", () => {
  const r = Kyoot.runSync(
    FileSystem.mkdir("/file", { recursive: true }).pipe(Memory.fs({ "/file": "x" }), Fail.run),
  );
  assert.ok(!r.ok && r.cause._tag === "Fail");
  assert.equal(r.cause.error.code, "AlreadyExists");
});

test("memory: a handled program starts with new files and timestamps on every run", () => {
  const handled = Kyoot.gen(function* () {
    yield* FileSystem.mkdir("/new");
    yield* FileSystem.appendFile("/seed.txt", "!");
    const stat = yield* FileSystem.stat("/seed.txt");
    return { text: yield* FileSystem.readFile("/seed.txt"), mtime: stat.mtime };
  }).pipe(Memory.fs({ "/seed.txt": "seed" }), Fail.orThrow);

  const [first, firstFiles] = Kyoot.runSync(handled);
  const [second, secondFiles] = Kyoot.runSync(handled);
  assert.equal(first.text, "seed!");
  assert.equal(second.text, "seed!");
  assert.notStrictEqual(first.mtime, second.mtime);
  assert.deepEqual(firstFiles, { "/seed.txt": "seed!" });
  assert.deepEqual(secondFiles, { "/seed.txt": "seed!" });
});

const sharedConformance = (root: string) =>
  Kyoot.gen(function* () {
    yield* FileSystem.mkdir(root, { recursive: true });
    yield* FileSystem.mkdir(`${root}/a`);
    yield* FileSystem.writeFile(`${root}/a/../utf8.txt`, "€x");
    const utf8 = yield* FileSystem.stat(`${root}/./utf8.txt`);

    yield* FileSystem.writeFile(`${root}/source-file`, "source");
    yield* FileSystem.writeFile(`${root}/target-file`, "target");
    yield* FileSystem.rename(`${root}/source-file`, `${root}/target-file`);
    const replaced = yield* FileSystem.readFile(`${root}/target-file`);

    yield* FileSystem.writeFile(`${root}/file-to-dir`, "file");
    yield* FileSystem.mkdir(`${root}/dir-target`);
    const fileToDir = yield* caughtCode(
      FileSystem.rename(`${root}/file-to-dir`, `${root}/dir-target`),
    );

    yield* FileSystem.mkdir(`${root}/dir-to-file`);
    yield* FileSystem.writeFile(`${root}/file-target`, "file");
    const dirToFile = yield* caughtCode(
      FileSystem.rename(`${root}/dir-to-file`, `${root}/file-target`),
    );

    yield* FileSystem.mkdir(`${root}/replace-dir/source`, { recursive: true });
    yield* FileSystem.writeFile(`${root}/replace-dir/source/value`, "moved");
    yield* FileSystem.mkdir(`${root}/replace-dir/target`);
    yield* FileSystem.rename(`${root}/replace-dir/source`, `${root}/replace-dir/target`);
    const replacedDir = yield* FileSystem.readFile(`${root}/replace-dir/target/value`);

    yield* FileSystem.mkdir(`${root}/nonempty/source`, { recursive: true });
    yield* FileSystem.mkdir(`${root}/nonempty/target`);
    yield* FileSystem.writeFile(`${root}/nonempty/target/value`, "kept");
    const nonempty = yield* caughtCode(
      FileSystem.rename(`${root}/nonempty/source`, `${root}/nonempty/target`),
    );

    yield* FileSystem.mkdir(`${root}/tree/child`, { recursive: true });
    const subtree = yield* caughtCode(
      FileSystem.rename(`${root}/tree`, `${root}/tree/child/moved`),
    );

    return {
      utf8: { type: utf8.type, size: utf8.size },
      replaced,
      fileToDir,
      dirToFile,
      replacedDir,
      nonempty,
      subtree,
    };
  });

test("memory and node agree on paths, byte sizes, and rename constraints", async () => {
  const [memory] = Kyoot.runSync(sharedConformance("/sandbox").pipe(Memory.fs(), Fail.orThrow));
  const root = await fsp.mkdtemp(join(tmpdir(), "kyoot-"));
  try {
    const node = await Kyoot.runPromise(sharedConformance(root).pipe(Node.fs, Fail.orThrow));
    assert.deepEqual(memory, node);
  } finally {
    await fsp.rm(root, { recursive: true });
  }
});

test("node: errors carry codes", async () => {
  const r = await Kyoot.runPromise(FileSystem.readFile("/nope/nope").pipe(Node.fs, Fail.run));
  assert.ok(!r.ok && r.cause._tag === "Fail");
  assert.equal(r.cause.error.code, "NotFound");
  assert.equal(r.cause.error.op, "readFile");
});

test("node: exists returns false when a path component is not a directory", async () => {
  const root = await fsp.mkdtemp(join(tmpdir(), "kyoot-"));
  try {
    await fsp.writeFile(`${root}/file`, "x");
    const r = await Kyoot.runPromise(
      FileSystem.exists(`${root}/file/child`).pipe(Node.fs, Fail.orThrow),
    );
    assert.equal(r, false);
  } finally {
    await fsp.rm(root, { recursive: true });
  }
});
