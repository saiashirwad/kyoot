import { spawn, type ChildProcess } from "node:child_process";
import * as fsp from "node:fs/promises";
import { Async, Fail, Kyoot, Resource } from "kyoot";
import type { Kyoot as K, Row } from "kyoot";
import * as Command from "./command.ts";
import * as FileSystem from "./fs.ts";

const attempt = <A, E>(f: () => Promise<A>, onError: (e: unknown) => E) =>
  Async.fromPromise(() =>
    f().then(
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

const performFs = (op: FileSystem.Op): Promise<FileSystem.Answer[FileSystem.Kind]> => {
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
      return fsp.mkdir(op.path, { recursive: op.recursive }).then(() => undefined);
    case "remove":
      return (
        op.recursive
          ? fsp.rm(op.path, { recursive: true })
          : fsp
              .stat(op.path)
              .then((s) => (s.isDirectory() ? fsp.rmdir(op.path) : fsp.unlink(op.path)))
      ).then(() => undefined);
    case "rename":
      return fsp.rename(op.path, op.to).then(() => undefined);
  }
};

const runFsOperation = <K extends FileSystem.Kind>(
  op: FileSystem.Operation<K>,
  resume: FileSystem.OperationResume<K>,
) =>
  attempt(
    () => performFs(op) as Promise<FileSystem.Answer[K]>,
    (error) => fsError(op, error),
  ).flatMap((result) => (result.ok ? resume(result.value) : resume.with(Fail.fail(result.error))));

export const fs = FileSystem.handle({
  readFile: runFsOperation,
  writeFile: runFsOperation,
  appendFile: runFsOperation,
  readDir: runFsOperation,
  stat: runFsOperation,
  exists: runFsOperation,
  mkdir: runFsOperation,
  remove: runFsOperation,
  rename: runFsOperation,
});

interface RunningCommand {
  readonly result: Promise<Command.Output>;
  readonly closed: Promise<void>;
  stop(): void;
}

const outputLimit = (op: Command.Op) => {
  const limit = op.maxOutputBytes ?? Command.DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Command.CommandError(
      op.command,
      "InvalidOutputLimit",
      "maxOutputBytes must be a non-negative safe integer",
      limit,
    );
  }
  return limit;
};

const start = (op: Command.Op, signal: AbortSignal): RunningCommand => {
  const limit = outputLimit(op);
  let child: ChildProcess;
  try {
    child = spawn(op.command, op.args, {
      cwd: op.cwd,
      env: op.env === undefined ? undefined : { ...process.env, ...op.env },
      stdio: "pipe",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Command.CommandError(op.command, "StartFailed", message);
  }

  let closed = false;
  let stopped = false;
  let startError: Error | undefined;
  let exceeded = false;
  let outputBytes = 0;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let close!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    close = resolve;
  });
  const stop = () => {
    if (stopped || closed) return;
    stopped = true;
    child.kill("SIGTERM");
  };
  const collect = (chunks: Buffer[]) => (chunk: Buffer | string) => {
    if (exceeded) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    outputBytes += bytes.length;
    if (outputBytes > limit) {
      exceeded = true;
      stop();
      return;
    }
    chunks.push(bytes);
  };
  child.stdout?.on("data", collect(stdout));
  child.stderr?.on("data", collect(stderr));
  child.once("error", (error) => {
    startError = error;
  });
  child.once("close", () => {
    closed = true;
    signal.removeEventListener("abort", stop);
    close();
  });
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  child.stdin?.end(op.stdin ?? "");

  return {
    closed: closedPromise,
    stop,
    result: closedPromise.then(() => {
      if (startError !== undefined) {
        throw new Command.CommandError(op.command, "StartFailed", startError.message);
      }
      if (exceeded) {
        throw new Command.CommandError(
          op.command,
          "OutputLimitExceeded",
          `command output exceeded ${limit} bytes`,
          limit,
        );
      }
      return {
        code: child.exitCode,
        signal: child.signalCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
    }),
  };
};

export const command = Command.handle({
  onOp: (op, resume) => {
    let running: RunningCommand | undefined;
    let released = false;
    const release = () => {
      const current = running;
      if (released || current === undefined) return;
      released = true;
      current.stop();
      return Async.fromPromise(() => current.closed);
    };
    return Kyoot.gen(function* () {
      yield* Resource.acquire(() => undefined, release);
      return yield* Async.fromPromise((signal) => {
        try {
          const current = start(op, signal);
          running = current;
          return current.result
            .then(
              (value) => ({ ok: true as const, value }),
              (error: unknown) => ({ ok: false as const, error }),
            )
            .finally(() => {
              running = undefined;
            });
        } catch (error) {
          return Promise.resolve({ ok: false as const, error });
        }
      });
    })
      .pipe(Resource.run)
      .flatMap((result) =>
        result.ok
          ? resume(result.value)
          : resume.with(
              Fail.fail(
                result.error instanceof Command.CommandError
                  ? result.error
                  : new Command.CommandError(
                      op.command,
                      "StartFailed",
                      result.error instanceof Error ? result.error.message : String(result.error),
                    ),
              ),
            ),
      );
  },
});

export const provide = <A, S extends Row & { fs?: FileSystem.Op; command?: Command.Op }>(
  k: K<A, S>,
) => k.pipe(fs, command);
