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

for (const destination of ["/d/sub/moved", "/d/sub/../sub/moved"]) {
  test(`rename refuses a directory descendant ${destination} without changing the tree`, async () => {
    const initial = { "/d/sub/x": "child", "/d/y": "parent" };
    const program = Kyoot.gen(function* () {
      const result = yield* FileSystem.rename("/d", destination).pipe(Fail.run);
      const directories = yield* FileSystem.readDir("/d").pipe(Fail.run);
      const children = yield* FileSystem.readDir("/d/sub").pipe(Fail.run);
      return { result, directories, children };
    });
    const [memory, files] = Kyoot.runSync(program.pipe(Memory.fs(initial), Fail.orThrow));
    const root = await fsp.mkdtemp(join(tmpdir(), "kyoot-rename-"));
    try {
      await fsp.mkdir(`${root}/d/sub`, { recursive: true });
      await fsp.writeFile(`${root}/d/sub/x`, "child");
      await fsp.writeFile(`${root}/d/y`, "parent");
      const real = await Kyoot.runPromise(
        FileSystem.rename(`${root}/d`, `${root}${destination}`).pipe(Node.fs, Fail.run),
      );
      assert.ok(!real.ok && real.cause._tag === "Fail");
      assert.ok(!memory.result.ok && memory.result.cause._tag === "Fail");
      assert.equal(memory.result.cause.error.code, real.cause.error.code);
      assert.ok(memory.directories.ok);
      assert.ok(memory.children.ok);
      assert.deepEqual(memory.directories.value.sort(), ["sub", "y"]);
      assert.deepEqual(memory.children.value.sort(), ["x"]);
      assert.deepEqual(files, initial);
      assert.equal(await fsp.readFile(`${root}/d/sub/x`, "utf8"), "child");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
}

test("memory: rename to the same normalized path is a no-op", () => {
  const initial = { "/d/sub/x": "child" };
  const program = Kyoot.gen(function* () {
    yield* FileSystem.rename("/d", "/d/.");
    yield* FileSystem.rename("/d/sub/x", "/d/sub/../sub/x");
    return yield* FileSystem.readDir("/d/sub");
  });
  const [children, files] = Kyoot.runSync(program.pipe(Memory.fs(initial), Fail.orThrow));
  assert.deepEqual(children, ["x"]);
  assert.deepEqual(files, initial);
});

for (const [sourceType, destinationType] of [
  ["file", "directory"],
  ["directory", "file"],
  ["directory", "nonempty directory"],
] as const) {
  test(`rename refuses ${sourceType} over ${destinationType} without changing files`, async () => {
    const initial = {
      ...(sourceType === "file" ? { "/source": "source" } : { "/source/x": "source" }),
      ...(destinationType === "file"
        ? { "/destination": "destination" }
        : { "/destination/y": "destination" }),
    };
    const program = Kyoot.gen(function* () {
      return yield* FileSystem.rename("/source", "/destination").pipe(Fail.run);
    });
    const [memory, files] = Kyoot.runSync(program.pipe(Memory.fs(initial)));
    const root = await fsp.mkdtemp(join(tmpdir(), "kyoot-rename-"));
    try {
      for (const [path, data] of Object.entries(initial)) {
        await fsp.mkdir(join(root, path, ".."), { recursive: true });
        await fsp.writeFile(join(root, path), data);
      }
      const real = await Kyoot.runPromise(
        FileSystem.rename(`${root}/source`, `${root}/destination`).pipe(Node.fs, Fail.run),
      );
      assert.ok(!real.ok && real.cause._tag === "Fail");
      assert.ok(!memory.ok && memory.cause._tag === "Fail");
      assert.equal(memory.cause.error.code, real.cause.error.code);
      assert.deepEqual(files, initial);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
}

test("memory: directory rename replaces an empty destination and preserves the moved subtree", () => {
  const program = Kyoot.gen(function* () {
    yield* FileSystem.mkdir("/destination");
    yield* FileSystem.rename("/source", "/destination");
    const oldSource = yield* FileSystem.exists("/source");
    const children = yield* FileSystem.readDir("/destination/sub");
    return { oldSource, children };
  });
  const [result, files] = Kyoot.runSync(
    program.pipe(Memory.fs({ "/source/sub/x": "moved" }), Fail.orThrow),
  );
  assert.deepEqual(result, { oldSource: false, children: ["x"] });
  assert.deepEqual(files, { "/destination/sub/x": "moved" });
});

test("memory: sibling names with a shared prefix are not descendants", () => {
  const [result, files] = Kyoot.runSync(
    FileSystem.rename("/d", "/d2").pipe(Memory.fs({ "/d/x": "moved" }), Fail.orThrow),
  );
  assert.equal(result, undefined);
  assert.deepEqual(files, { "/d2/x": "moved" });
});

test("memory: file rename replaces an existing file", () => {
  const [, files] = Kyoot.runSync(
    FileSystem.rename("/source", "/destination").pipe(
      Memory.fs({ "/source": "new", "/destination": "old" }),
      Fail.orThrow,
    ),
  );
  assert.deepEqual(files, { "/destination": "new" });
});
