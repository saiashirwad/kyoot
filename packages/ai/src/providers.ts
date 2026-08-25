import { Async, Emit, Env, Fail, Kyoot, Retry } from "kyoot";
import { Model, type Message, type Request, type ToolCall } from "./model.ts";
import { events } from "./sse.ts";

export const ApiKey = Env.tag<string>()("ai/apiKey");

export class RateLimited {
  readonly _tag = "RateLimited";
  readonly status: number;
  constructor(status: number) {
    this.status = status;
  }
}

export interface Options {
  readonly url: string;
  readonly model: string;
  readonly retry?: Retry.Policy;
}

const toApi = (m: Message) =>
  m.role === "tool"
    ? { role: "tool", content: m.content, tool_call_id: m.toolCallId }
    : m.role === "assistant"
      ? {
          role: "assistant",
          content: m.content,
          tool_calls: m.toolCalls?.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.arguments },
          })),
        }
      : m;

const complete = (url: string, model: string, req: Request) =>
  Kyoot.gen(function* () {
    const apiKey = yield* ApiKey;
    const res = yield* Async.fromPromise((signal) =>
      fetch(url, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          stream: true,
          messages: req.messages.map(toApi),
          tools: req.tools?.map((t) => ({ type: "function", function: t })),
        }),
      }),
    );
    if (res.status === 429 || res.status >= 500) yield* Fail.fail(new RateLimited(res.status));
    if (!res.ok)
      throw new Error(`${url} ${res.status}: ${yield* Async.fromPromise(() => res.text())}`);
    const it = events(res.body!)[Symbol.asyncIterator]();
    let text = "";
    const calls: { id: string; name: string; arguments: string }[] = [];
    while (true) {
      const r = yield* Async.fromPromise(() => it.next());
      if (r.done) break;
      const delta = (r.value as any).choices?.[0]?.delta ?? {};
      if (delta.content) {
        text += delta.content;
        yield* Emit.value<string>(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const call = (calls[tc.index] ??= { id: "", name: "", arguments: "" });
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.name += tc.function.name;
        if (tc.function?.arguments) call.arguments += tc.function.arguments;
      }
    }
    return { text, toolCalls: calls.filter(Boolean) as ToolCall[] };
  });

export const chatCompletions = ({
  url,
  model,
  retry = { times: 3, delay: (n) => 500 * 2 ** n },
}: Options) =>
  Model.handle({
    onOp: (req, resume) => complete(url, model, req).pipe(Retry.run(retry)).map(resume),
  });

export const deepseek = (model = "deepseek-chat") =>
  chatCompletions({ url: "https://api.deepseek.com/chat/completions", model });

export const openai = (model = "gpt-4o-mini") =>
  chatCompletions({ url: "https://api.openai.com/v1/chat/completions", model });
