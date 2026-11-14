import { posix } from "node:path";
import { Kyoot } from "kyoot";
import * as Fail from "kyoot/fail";
import type { Kyoot as K, Op as RowOp, Resume, Row } from "kyoot";
import {
  FsError,
  handle,
  type Answer,
  type Code,
  type FsRow,
  type Name,
  type Payload,
} from "./fs.ts";

const { resolve, dirname, basename } = posix;

const under = (path: string, root: string) =>
  path === root || path.startsWith(root === "/" ? "/" : `${root}/`);

export const fs =
  (initial: Record<string, string> = {}) =>
  <A, S extends Row & Partial<FsRow>>(k: K<A, S>) =>
    Kyoot.gen(function* () {
      const files = new Map<string, { data: string; mtime: Date }>();
      const dirs = new Set(["/"]);
      const mkdirp = (dir: string) => {
        for (let d = dir; !dirs.has(d); d = dirname(d)) dirs.add(d);
      };
      for (const [path, data] of Object.entries(initial)) {
        mkdirp(dirname(resolve("/", path)));
        files.set(resolve("/", path), { data, mtime: new Date() });
      }

      type Fail = (code: Code, message: string) => never;
      const requireDir = (fail: Fail, dir: string) => {
        if (files.has(dir)) fail("NotADirectory", `${dir} is a file`);
        if (!dirs.has(dir)) fail("NotFound", `${dir} does not exist`);
      };
      const children = (dir: string) =>
        [...files.keys(), ...dirs]
          .filter((p) => p !== "/" && dirname(p) === dir)
          .map((p) => basename(p));
      const subtree = (root: string) =>
        [...files.keys(), ...dirs].filter((p) => p !== "/" && under(p, root));
      const write = (fail: Fail, path: string, data: string, append: boolean) => {
        requireDir(fail, dirname(path));
        if (dirs.has(path)) fail("IsADirectory", `${path} is a directory`);
        const before = append ? (files.get(path)?.data ?? "") : "";
        files.set(path, { data: before + data, mtime: new Date() });
      };

      // Each op answers from the shared maps; a thrown FsError becomes a typed failure.
      const op =
        <N extends Name>(name: N, f: (p: Payload[N], path: string, fail: Fail) => Answer[N]) =>
        (p: Payload[N], resume: Resume<Answer[N], { fail: RowOp<FsError, never> }>) => {
          const fail: Fail = (code, message) => {
            throw new FsError(name, p.path, code, message);
          };
          try {
            return resume(f(p, resolve("/", p.path), fail));
          } catch (e) {
            if (e instanceof FsError) return resume.with(Fail.fail(e));
            throw e;
          }
        };

      const a = yield* k.pipe(
        handle({
          readFile: op("readFile", (_, path, fail) => {
            if (dirs.has(path)) fail("IsADirectory", `${path} is a directory`);
            return files.get(path)?.data ?? fail("NotFound", `${path} does not exist`);
          }),
          writeFile: op("writeFile", (p, path, fail) => write(fail, path, p.data, false)),
          appendFile: op("appendFile", (p, path, fail) => write(fail, path, p.data, true)),
          readDir: op("readDir", (_, path, fail) => {
            requireDir(fail, path);
            return children(path);
          }),
          stat: op("stat", (_, path, fail) => {
            const file = files.get(path);
            if (file) return { type: "file", size: file.data.length, mtime: file.mtime };
            if (dirs.has(path)) return { type: "directory", size: 0, mtime: new Date(0) };
            return fail("NotFound", `${path} does not exist`);
          }),
          exists: op("exists", (_, path) => files.has(path) || dirs.has(path)),
          mkdir: op("mkdir", (p, path, fail) => {
            if (p.recursive) {
              if (files.has(path)) fail("AlreadyExists", `${path} exists`);
              for (let d = dirname(path); !dirs.has(d); d = dirname(d)) {
                if (files.has(d)) fail("NotADirectory", `${d} is a file`);
              }
              mkdirp(path);
              return;
            }
            if (files.has(path) || dirs.has(path)) fail("AlreadyExists", `${path} exists`);
            requireDir(fail, dirname(path));
            dirs.add(path);
          }),
          remove: op("remove", (p, path, fail) => {
            if (files.delete(path)) return;
            if (!dirs.has(path)) fail("NotFound", `${path} does not exist`);
            if (!p.recursive && children(path).length > 0) fail("NotEmpty", `${path} is not empty`);
            for (const q of subtree(path)) {
              files.delete(q);
              dirs.delete(q);
            }
          }),
          rename: op("rename", (p, path, fail) => {
            const to = resolve("/", p.to);
            requireDir(fail, dirname(to));
            if (!files.has(path) && !dirs.has(path)) fail("NotFound", `${path} does not exist`);
            if (to === path) return;
            if (dirs.has(path)) {
              if (under(to, path)) fail("Other", `${to} is inside ${path}`);
              if (files.has(to)) fail("NotADirectory", `${to} is a file`);
              if (children(to).length > 0) fail("NotEmpty", `${to} is not empty`);
            } else if (dirs.has(to)) {
              fail("IsADirectory", `${to} is a directory`);
            }
            for (const q of subtree(path)) {
              const moved = to + q.slice(path.length);
              const file = files.get(q);
              if (file) {
                files.delete(q);
                files.set(moved, file);
              } else {
                dirs.delete(q);
                dirs.add(moved);
              }
            }
          }),
        }),
      );
      return [a, Object.fromEntries([...files].map(([p, f]) => [p, f.data]))] as const;
    });
