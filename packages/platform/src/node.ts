import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import { Async, Fail } from "kyoot";
import type { Kyoot as K, Row } from "kyoot";
import * as Command from "./command.ts";
import * as FileSystem from "./fs.ts";

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

export const fs = FileSystem.handle({
  onOp: (op, resume) =>
    Fail.resumeOrFail(
      resume,
      Async.tryPromise(
        () => performFs(op),
        (e) => fsError(op, e),
      ),
    ),
});

const exec = (op: Command.Op) =>
  new Promise<Command.Output>((resolve, reject) => {
    const child = execFile(
      op.command,
      op.args,
      { cwd: op.cwd, env: op.env && { ...process.env, ...op.env } },
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
    Fail.resumeOrFail(
      resume,
      Async.tryPromise(
        () => exec(op),
        (e) => new Command.CommandError(op.command, (e as Error).message),
      ),
    ),
});

export const provide = <A, S extends Row & { fs?: FileSystem.Op; command?: Command.Op }>(
  k: K<A, S>,
) => k.pipe(fs, command);
