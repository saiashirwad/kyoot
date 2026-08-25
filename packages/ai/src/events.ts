import { makeHandler, op } from "kyoot";
import type { Kyoot, Row } from "kyoot";
import type { ToolCall } from "./model.ts";

export type Event =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "call"; readonly call: ToolCall }
  | { readonly type: "result"; readonly call: ToolCall; readonly content: string };

export const emit = (event: Event) => op<void>()("ai/event", event);

export const forEach =
  (f: (event: Event) => void) =>
  <A, S extends Row & { "ai/event"?: Event }>(k: Kyoot<A, S>) =>
    makeHandler("ai/event", k, { onOp: (event, resume) => (f(event), resume(undefined)) });

export const print = forEach((e) =>
  process.stdout.write(
    e.type === "text"
      ? e.text
      : e.type === "call"
        ? `\n→ ${e.call.name}(${e.call.arguments})\n`
        : `← ${e.content}\n`,
  ),
);

export const discard = forEach(() => {});
