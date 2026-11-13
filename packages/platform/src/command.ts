import { effect } from "kyoot";
import type { Op as RowOp } from "kyoot";

export interface Options {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly stdin?: string;
}

export interface Op extends Options {
  readonly command: string;
  readonly args: readonly string[];
}

export interface Output {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class CommandError {
  readonly _tag = "CommandError";
  readonly command: string;
  readonly message: string;
  constructor(command: string, message: string) {
    this.command = command;
    this.message = message;
  }
}

export type CommandRow = { command: RowOp<Op, Output> };

const command = effect<Op, Output, { fail: RowOp<CommandError, never> }>()("command");

export const handle = command.handle;

export const intercept = command.intercept;

export const run = (name: string, args: readonly string[] = [], options: Options = {}) =>
  command({ command: name, args, ...options });
