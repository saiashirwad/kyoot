import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as Fail from "kyoot/fail";
import type { Kyoot as K, Row } from "kyoot";
import * as Command from "./command.ts";
import * as FileSystem from "./fs.ts";
import { Async } from "kyoot/async";

const codes: Record<string, FileSystem.Code> = {
  ENOENT: "NotFound",
  EEXIST: "AlreadyExists",
  EACCES: "PermissionDenied",
  EPERM: "PermissionDenied",
  ENOTDIR: "NotADirectory",
  EISDIR: "IsADirectory",
  ENOTEMPTY: "NotEmpty",
};

const attempt = <A>(name: FileSystem.Name, path: string, run: () => Promise<A>) =>
  Async.tryPromise(run, (e) => {
    const { code = "", message } = e as { code?: string; message: string };
    return new FileSystem.FsError(name, path, codes[code] ?? "Other", message);
  });

export const fs = FileSystem.handle({
  readFile: ({ path }, resume) =>
    Fail.resumeOrFail(
      resume,
      attempt("readFile", path, () => fsp.readFile(path, "utf8")),
    ),
  writeFile: ({ path, data }, resume) =>
    Fail.resumeOrFail(
      resume,
      attempt("writeFile", path, () => fsp.writeFile(path, data)),
    ),
  appendFile: ({ path, data }, resume) =>
    Fail.resumeOrFail(
      resume,
      attempt("appendFile", path, () => fsp.appendFile(path, data)),
    ),
  readDir: ({ path }, resume) =>
    Fail.resumeOrFail(
      resume,
      attempt("readDir", path, () => fsp.readdir(path)),
    ),
  stat: ({ path }, resume) =>
    Fail.resumeOrFail(
      resume,
      attempt("stat", path, async (): Promise<FileSystem.Stat> => {
        const s = await fsp.stat(path);
        return {
          type: s.isFile() ? "file" : s.isDirectory() ? "directory" : "other",
          size: s.size,
          mtime: s.mtime,
        };
      }),
    ),
  exists: ({ path }, resume) =>
    Fail.resumeOrFail(
      resume,
      attempt("exists", path, () =>
        fsp.access(path).then(
          () => true,
          (e: unknown) => {
            const code = (e as { code?: string }).code;
            if (code === "ENOENT" || code === "ENOTDIR") return false;
            throw e;
          },
        ),
      ),
    ),
  mkdir: ({ path, recursive }, resume) =>
    Fail.resumeOrFail(
      resume,
      attempt("mkdir", path, async () => {
        await fsp.mkdir(path, { recursive });
      }),
    ),
  remove: ({ path, recursive }, resume) =>
    Fail.resumeOrFail(
      resume,
      attempt("remove", path, async () => {
        if (recursive) return fsp.rm(path, { recursive: true });
        const s = await fsp.stat(path);
        return s.isDirectory() ? fsp.rmdir(path) : fsp.unlink(path);
      }),
    ),
  rename: ({ path, to }, resume) =>
    Fail.resumeOrFail(
      resume,
      attempt("rename", path, () => fsp.rename(path, to)),
    ),
});

const exec = (op: Command.Op, signal: AbortSignal) =>
  new Promise<Command.Output>((resolve, reject) => {
    const child = execFile(
      op.command,
      op.args,
      { cwd: op.cwd, env: op.env && { ...process.env, ...op.env }, signal },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : err.code;
        if (typeof code === "number") resolve({ code, stdout, stderr });
        else reject(err);
      },
    );
    child.stdin?.end(op.stdin ?? "");
  });

export const command = Command.handle((op, resume) =>
  Fail.resumeOrFail(
    resume,
    Async.tryPromise(
      (signal) => exec(op, signal),
      (e) => new Command.CommandError(op.command, (e as Error).message),
    ),
  ),
);

export const provide = <A, S extends Row & Partial<FileSystem.FsRow & Command.CommandRow>>(
  k: K<A, S>,
) => k.pipe(fs, command);
