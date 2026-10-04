import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import { Async, Fail } from "kyoot";
import type { Kyoot as K, Row, Requirement } from "kyoot";
import * as Command from "./command.ts";
import * as FileSystem from "./fs.ts";

const attempt = <A, E>(f: (signal: AbortSignal) => Promise<A>, onError: (e: unknown) => E) =>
  Async.fromPromise((signal) =>
    f(signal).then(
      (value) => ({ ok: true as const, value }),
      (e: unknown) => ({ ok: false as const, error: onError(e) }),
    ),
  );

const codes: Record<string, FileSystem.Code> = {
  ENOENT: "NotFound",
  EEXIST: "AlreadyExists",
  EACCES: "PermissionDenied",
  EPERM: "PermissionDenied",
  ENOTDIR: "NotADirectory",
  EISDIR: "IsADirectory",
  ENOTEMPTY: "NotEmpty",
};

const fsError = (op: FileSystem.Op, e: unknown) => {
  const { code = "", message } = e as { code?: string; message: string };
  return new FileSystem.FsError(op.kind, op.path, codes[code] ?? "Other", message);
};

const performFs = (op: FileSystem.Op): Promise<unknown> => {
  switch (op.kind) {
    case "readFile":
      return fsp.readFile(op.path, "utf8");
    case "writeFile":
      return fsp.writeFile(op.path, op.data);
    case "appendFile":
      return fsp.appendFile(op.path, op.data);
    case "readDir":
      return fsp.readdir(op.path);
    case "stat":
      return fsp.stat(op.path).then((s) => ({
        type: s.isFile() ? "file" : s.isDirectory() ? "directory" : "other",
        size: s.size,
        mtime: s.mtime,
      }));
    case "exists":
      return fsp.access(op.path).then(
        () => true,
        (e: unknown) => {
          const code = (e as { code?: string }).code;
          if (code === "ENOENT" || code === "ENOTDIR") return false;
          throw e;
        },
      );
    case "mkdir":
      return fsp.mkdir(op.path, { recursive: op.recursive });
    case "remove":
      return op.recursive
        ? fsp.rm(op.path, { recursive: true })
        : fsp
            .stat(op.path)
            .then((s) => (s.isDirectory() ? fsp.rmdir(op.path) : fsp.unlink(op.path)));
    case "rename":
      return fsp.rename(op.path, op.to);
  }
};

export const fs = FileSystem.unsafeHandle({
  onOp: (op, resume) =>
    attempt(
      () => performFs(op),
      (e) => fsError(op, e),
    ).flatMap((r) => (r.ok ? resume(r.value) : resume.with(Fail.fail(r.error)))),
});

const exec = (op: Command.Op, signal: AbortSignal) =>
  new Promise<Command.Output>((resolve, reject) => {
    const maxBuffer = op.maxBuffer ?? 1024 * 1024;
    if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 0) {
      throw new RangeError("maxBuffer must be a nonnegative safe integer number of bytes");
    }
    const child = execFile(
      op.command,
      op.args,
      { cwd: op.cwd, env: op.env && { ...process.env, ...op.env }, maxBuffer, signal },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : err.code;
        if (typeof code === "number") resolve({ code, stdout, stderr });
        else reject(err);
      },
    );
    child.stdin?.end(op.stdin ?? "");
  });

export const command = Command.handle({
  onOp: (op, resume) =>
    attempt(
      (signal) => exec(op, signal),
      (e) => new Command.CommandError(op.command, e instanceof Error ? e.message : String(e)),
    ).flatMap((r) => (r.ok ? resume(r.value) : resume.with(Fail.fail(r.error)))),
});

export const provide = <
  A,
  S extends Row &
    Partial<FileSystem.FileSystemRow> & {
      command?: Requirement<
        Command.Op,
        Command.Output,
        Command.Op,
        { fail: Requirement<Command.CommandError, never> }
      >;
    },
>(
  k: K<A, S>,
) => k.pipe(fs, command);
