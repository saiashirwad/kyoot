import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request } from "@kyoot/ai";
import { host } from "../examples/host.ts";

test("sans-IO: the host answers the model, approval, and the tool's own effect", () => {
  const call = { id: "1", name: "forecast", arguments: '{"city":"Pune"}' };
  const { answer, requests } = host([
    { text: "", toolCalls: [call] },
    { text: "Yes, it will rain.", toolCalls: [] },
  ]);
  const user = { role: "user", content: "Do I need an umbrella in Pune?" };
  const asked = { role: "assistant", content: "", toolCalls: [call] };
  const shown = requests.map(([key, payload]) => [
    key,
    key === "ai/model" ? (payload as Request).messages : payload,
  ]);
  assert.equal(answer, "Yes, it will rain.");
  assert.deepEqual(shown, [
    ["ai/model", [user]],
    ["ai/approve", { tool: "forecast", args: { city: "Pune" } }],
    ["forecast", { city: "Pune" }],
    ["ai/model", [user, asked, { role: "tool", toolCallId: "1", content: '"rain"' }]],
  ]);
});
