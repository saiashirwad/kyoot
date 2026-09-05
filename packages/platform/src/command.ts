import { effect } from "kyoot";

/** The combined stdout and stderr limit used when no limit is supplied. */
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * On interruption, the Node handler sends SIGTERM to the launched process and waits for it to
 * close. It does not promise to terminate processes that the command starts.
 */
export interface Options {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly stdin?: string;
  /**
   * The largest combined stdout and stderr output, in UTF-8 bytes.
   *
   * The limit defaults to `DEFAULT_MAX_OUTPUT_BYTES` and must be a non-negative safe integer.
   */
  readonly maxOutputBytes?: number;
}

export interface Op extends Options {
  readonly command: string;
  readonly args: readonly string[];
}

export interface Output {
  /** A normal exit code. Signal termination sets this to `null`. */
  readonly code: number | null;
  /** The terminating signal, or `null` for a normal exit, including a nonzero one. */
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandErrorKind = "StartFailed" | "InvalidOutputLimit" | "OutputLimitExceeded";

export class CommandError {
  readonly _tag = "CommandError";
  readonly command: string;
  readonly kind: CommandErrorKind;
  readonly message: string;
  readonly limit: number | undefined;
  constructor(command: string, kind: CommandErrorKind, message: string, limit?: number) {
    this.command = command;
    this.kind = kind;
    this.message = message;
    this.limit = limit;
  }
}

const command = effect<Op, Output, { fail: CommandError }>()("command");

export const handle = command.handle;

export const intercept = command.intercept;

export const run = (name: string, args: readonly string[] = [], options: Options = {}) =>
  command({ command: name, args, ...options });
