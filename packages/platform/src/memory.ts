import { posix } from "node:path";
import { Fail, Kyoot } from "kyoot";
import { makeHandler } from "kyoot/internal";
import type { Kyoot as K, Row } from "kyoot";
import { FsError, type Code, type Op } from "./fs.ts";

const { resolve, dirname, basename } = posix;

interface File {
  readonly data: string;
  readonly mtime: Date;
}

interface State {
  readonly files: Map<string, File>;
  readonly dirs: Map<string, Date>;
}

const under = (path: string, root: string) =>
  path === root || path.startsWith(root === "/" ? "/" : `${root}/`);

const makeState = (initial: Record<string, string>): State => {
  const dirs = new Map<string, Date>([["/", new Date()]]);
  const files = new Map<string, File>();
  const mkdirp = (dir: string) => {
    const missing: string[] = [];
    for (let current = dir; !dirs.has(current); current = dirname(current)) missing.push(current);
    for (let i = missing.length - 1; i >= 0; i--) dirs.set(missing[i]!, new Date());
  };
  for (const [path, data] of Object.entries(initial)) {
    const normalized = resolve("/", path);
    mkdirp(dirname(normalized));
    files.set(normalized, { data, mtime: new Date() });
  }
  return { files, dirs };
};

const run = (state: State, op: Op): unknown => {
  const { files, dirs } = state;
  const path = resolve("/", op.path);
  const fail = (code: Code, message: string): never => {
    throw new FsError(op.kind, op.path, code, message);
  };
  const touch = (dir: string) => dirs.set(dir, new Date());
  const requireDir = (dir: string) => {
    if (files.has(dir)) fail("NotADirectory", `${dir} is a file`);
    if (!dirs.has(dir)) fail("NotFound", `${dir} does not exist`);
  };
  const mkdirp = (dir: string) => {
    const missing: string[] = [];
    for (let current = dir; !dirs.has(current); current = dirname(current)) missing.push(current);
    for (let i = missing.length - 1; i >= 0; i--) {
      const current = missing[i]!;
      dirs.set(current, new Date());
      touch(dirname(current));
    }
  };
  const children = (dir: string) =>
    [...files.keys(), ...dirs.keys()]
      .filter((p) => p !== "/" && dirname(p) === dir)
      .map((p) => basename(p));
  const subtree = (root: string) =>
    [...files.keys(), ...dirs.keys()].filter((p) => p !== "/" && under(p, root));
  const removeTree = (root: string) => {
    for (const entry of subtree(root)) {
      files.delete(entry);
      dirs.delete(entry);
    }
  };

  switch (op.kind) {
    case "readFile": {
      if (dirs.has(path)) fail("IsADirectory", `${path} is a directory`);
      return files.get(path)?.data ?? fail("NotFound", `${path} does not exist`);
    }
    case "writeFile":
    case "appendFile": {
      const parent = dirname(path);
      requireDir(parent);
      if (dirs.has(path)) fail("IsADirectory", `${path} is a directory`);
      const existing = files.get(path);
      const data = op.kind === "appendFile" ? (existing?.data ?? "") + op.data : op.data;
      files.set(path, { data, mtime: new Date() });
      if (existing === undefined) touch(parent);
      return;
    }
    case "readDir":
      requireDir(path);
      return children(path);
    case "stat": {
      const file = files.get(path);
      if (file) return { type: "file", size: Buffer.byteLength(file.data), mtime: file.mtime };
      const mtime = dirs.get(path);
      if (mtime !== undefined) return { type: "directory", size: 0, mtime };
      return fail("NotFound", `${path} does not exist`);
    }
    case "exists":
      return files.has(path) || dirs.has(path);
    case "mkdir": {
      if (files.has(path)) fail("AlreadyExists", `${path} exists`);
      if (dirs.has(path)) {
        if (op.recursive) return;
        fail("AlreadyExists", `${path} exists`);
      }
      const parent = dirname(path);
      if (op.recursive) {
        for (let current = parent; !dirs.has(current); current = dirname(current)) {
          if (files.has(current)) fail("NotADirectory", `${current} is a file`);
        }
        mkdirp(path);
        return;
      }
      requireDir(parent);
      dirs.set(path, new Date());
      touch(parent);
      return;
    }
    case "remove": {
      if (path === "/") fail("Other", "cannot remove the root directory");
      if (files.delete(path)) {
        touch(dirname(path));
        return;
      }
      if (!dirs.has(path)) fail("NotFound", `${path} does not exist`);
      if (!op.recursive && children(path).length > 0) fail("NotEmpty", `${path} is not empty`);
      removeTree(path);
      touch(dirname(path));
      return;
    }
    case "rename": {
      const to = resolve("/", op.to);
      const sourceFile = files.get(path);
      const sourceDir = dirs.has(path);
      if (sourceFile === undefined && !sourceDir) fail("NotFound", `${path} does not exist`);
      if (path === to) return;
      if (sourceDir && under(to, path)) fail("Other", `${to} is inside ${path}`);
      const targetFile = files.get(to);
      const targetDir = dirs.has(to);
      if (sourceFile !== undefined && targetDir) fail("IsADirectory", `${to} is a directory`);
      if (sourceDir && targetFile !== undefined) fail("NotADirectory", `${to} is a file`);
      if (sourceDir && targetDir && children(to).length > 0) fail("NotEmpty", `${to} is not empty`);
      requireDir(dirname(to));
      if (targetFile !== undefined) files.delete(to);
      if (targetDir) removeTree(to);
      for (const entry of subtree(path)) {
        const moved = to + entry.slice(path.length);
        const file = files.get(entry);
        if (file !== undefined) {
          files.delete(entry);
          files.set(moved, file);
        } else {
          const mtime = dirs.get(entry)!;
          dirs.delete(entry);
          dirs.set(moved, mtime);
        }
      }
      touch(dirname(path));
      touch(dirname(to));
      return;
    }
  }
};

export const fs =
  (initial: Record<string, string> = {}) =>
  <A, S extends Row & { fs?: Op }, Ops>(k: K<A, S, Ops>) =>
    makeHandler("fs", k, {
      create: () => makeState(initial),
      onOp: (op, resume, state: State) => {
        try {
          return resume(run(state, op));
        } catch (error) {
          if (error instanceof FsError) return resume.with(Fail.fail(error));
          throw error;
        }
      },
      onSuccess: (value, state: State) =>
        Kyoot.succeed([
          value,
          Object.fromEntries([...state.files].map(([path, file]) => [path, file.data])),
        ] as const),
    });
