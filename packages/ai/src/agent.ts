import { Fail, Kyoot, Log } from "kyoot";
import type { Kyoot as K, MergeAll } from "kyoot";
import { Model, type Message, type Request } from "./model.ts";
import type { Tool } from "./tool.ts";

export class TooManyRounds {
  readonly _tag = "TooManyRounds";
}

type ToolRows<T> = T extends Tool<any, any, infer S> ? S : never;

export const ask = <T extends Tool>(
  question: string,
  tools: readonly T[],
  options: { readonly rounds?: number } = {},
): K<
  string,
  MergeAll<{ "ai/model": Request; fail: TooManyRounds; log: Log.Entry } | ToolRows<T>>
> =>
  Kyoot.gen(function* () {
    const messages: Message[] = [{ role: "user", content: question }];
    const byName = new Map(tools.map((t) => [t.schema.name, t]));
    for (let round = 0; round < (options.rounds ?? 5); round++) {
      const { text, toolCalls } = yield* Model({ messages, tools: tools.map((t) => t.schema) });
      if (toolCalls.length === 0) return text;
      messages.push({ role: "assistant", content: text, toolCalls });
      for (const call of toolCalls) {
        const t = byName.get(call.name);
        if (t === undefined) throw new Error(`unknown tool ${call.name}`);
        yield* Log.info(`tool ${call.name}(${call.arguments})`);
        const result = yield* t.run(JSON.parse(call.arguments));
        messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(result) });
      }
    }
    return yield* Fail.fail(new TooManyRounds());
  }) as never;
