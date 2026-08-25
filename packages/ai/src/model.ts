import { effect } from "kyoot";

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export type Message =
  | { readonly role: "system" | "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls?: readonly ToolCall[];
    }
  | { readonly role: "tool"; readonly content: string; readonly toolCallId: string };

export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: object;
}

export interface Request {
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolSchema[];
}

export interface Completion {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
}

export const Model = effect<Request, Completion>()("ai/model");
