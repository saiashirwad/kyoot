import type { Kyoot as K } from "kyoot";
import type { Requires } from "./generate.ts";
import type { Completion, Message, ToolCall } from "./model.ts";
import type { Tool } from "./tool.ts";

export class TurnBusy extends Error {
  readonly _tag = "TurnBusy";
  constructor() {
    super("The conversation has an unfinished or running turn");
  }
}

export class TurnDiscarded extends Error {
  readonly _tag = "TurnDiscarded";
  constructor() {
    super("This turn has been discarded");
  }
}

export class UnknownToolOutcome extends Error {
  readonly _tag = "UnknownToolOutcome";
  readonly call: ToolCall;
  constructor(call: ToolCall, cause?: unknown) {
    super(`The outcome of tool call ${call.id} is unknown; discard the turn to continue`, {
      cause,
    });
    this.call = call;
  }
}

export interface Turn<A, T extends Tool = never> {
  readonly run: K<A, Requires<T>>;
  discard(): void;
}

const snapshotCalls = (calls: readonly ToolCall[]): readonly ToolCall[] =>
  Object.freeze(calls.map((call) => Object.freeze({ ...call })));

export const snapshotCompletion = (completion: Completion): Completion =>
  Object.freeze({
    ...completion,
    toolCalls: snapshotCalls(completion.toolCalls),
    ...(completion.usage && { usage: Object.freeze({ ...completion.usage }) }),
  });

export const snapshot = (messages: readonly Message[]): Message[] =>
  messages.map((message) =>
    Object.freeze(
      message.role === "assistant" && message.toolCalls
        ? {
            ...message,
            toolCalls: snapshotCalls(message.toolCalls),
          }
        : { ...message },
    ),
  );
