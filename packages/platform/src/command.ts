import { effect } from "kyoot";
import type { Kyoot } from "kyoot";

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

const tag = effect<Op, Output>()("command");

export const handle = tag.handle;

export const run = (command: string, args: readonly string[] = [], options: Options = {}) =>
  tag({ command, args, ...options }) as Kyoot<Output, { command: Op; fail: CommandError }>;
