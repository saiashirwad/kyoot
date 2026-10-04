import { Async, Fail, Kyoot, Resource, Retry } from "kyoot";
import { Model, type Message, type Request } from "./model.ts";
import { events } from "./sse.ts";
import * as Events from "./events.ts";

export class ProviderError {
  readonly _tag = "ProviderError";
  readonly status: number;
  readonly message: string;
  constructor(status: number, message: string) {
    this.status = status;
    this.message = message;
  }
}

export interface Options {
  readonly url: string;
  readonly model: string;
  readonly apiKey: string;
  readonly retry?: Retry.Policy;
}

interface Chunk {
  readonly choices?: readonly {
    readonly delta: {
      readonly content?: string | null;
      readonly tool_calls?:
        | readonly {
            readonly index: number;
            readonly id?: string;
            readonly function?: { readonly name?: string; readonly arguments?: string };
          }[]
        | null;
    };
  }[];
  readonly usage?: { readonly prompt_tokens: number; readonly completion_tokens: number } | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isChunk = (value: unknown): value is Chunk => {
  if (!isRecord(value)) return false;
  if (value.choices !== undefined) {
    if (!Array.isArray(value.choices)) return false;
    for (const choice of value.choices) {
      if (!isRecord(choice) || !isRecord(choice.delta)) return false;
      const { content, tool_calls } = choice.delta;
      if (content !== undefined && content !== null && typeof content !== "string") return false;
      if (tool_calls === undefined || tool_calls === null) continue;
      if (!Array.isArray(tool_calls)) return false;
      for (const call of tool_calls) {
        if (
          !isRecord(call) ||
          typeof call.index !== "number" ||
          !Number.isSafeInteger(call.index) ||
          call.index < 0 ||
          (call.id !== undefined && typeof call.id !== "string")
        )
          return false;
        if (call.function !== undefined) {
          if (!isRecord(call.function)) return false;
          const { name, arguments: args } = call.function;
          if (
            (name !== undefined && typeof name !== "string") ||
            (args !== undefined && typeof args !== "string")
          )
            return false;
        }
      }
    }
  }
  if (value.usage !== undefined && value.usage !== null) {
    if (!isRecord(value.usage)) return false;
    for (const count of [value.usage.prompt_tokens, value.usage.completion_tokens]) {
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return false;
    }
  }
  return true;
};

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

const complete = ({ url, model, apiKey }: Options, req: Request) =>
  Kyoot.gen(function* () {
    const { res, signal } = yield* Async.fromPromise(async (signal) => ({
      res: await fetch(url, {
        method: "POST",
        signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          stream: true,
          stream_options: { include_usage: true },
          messages: req.messages.map(toApi),
          tools: req.tools?.map((t) => ({ type: "function", function: t })),
          tool_choice: req.tools && req.toolChoice,
          temperature: req.temperature,
          max_tokens: req.maxTokens,
        }),
      }),
      signal,
    }));
    if (!res.ok) {
      const message = yield* Async.fromPromise(() => res.text());
      yield* Fail.fail(new ProviderError(res.status, message));
    }
    const body = res.body;
    if (!body) return yield* Fail.fail(new ProviderError(502, "Missing response body"));
    const it = yield* Resource.acquire(
      () => events(body, signal)[Symbol.asyncIterator](),
      (iterator) => Async.fromPromise(() => iterator.return(false).then(() => undefined)),
    );
    let text = "";
    let usage = { input: 0, output: 0 };
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    while (true) {
      const r = yield* Async.fromPromise(() => it.next());
      if (r.done) {
        if (!r.value) return yield* Fail.fail(new ProviderError(422, "Incomplete provider stream"));
        break;
      }
      if (!isChunk(r.value))
        return yield* Fail.fail(new ProviderError(422, "Invalid provider chunk"));
      const { content, tool_calls } = r.value.choices?.[0]?.delta ?? {};
      if (content) {
        text += content;
        yield* Events.emit({ type: "text", text: content });
      }
      for (const tc of tool_calls ?? []) {
        const call = calls.get(tc.index) ?? { id: "", name: "", arguments: "" };
        if (tc.id !== undefined && call.id !== "" && tc.id !== call.id)
          return yield* Fail.fail(new ProviderError(422, "Conflicting tool call id"));
        call.id ||= tc.id ?? "";
        call.name += tc.function?.name ?? "";
        call.arguments += tc.function?.arguments ?? "";
        calls.set(tc.index, call);
      }
      if (r.value.usage)
        usage = { input: r.value.usage.prompt_tokens, output: r.value.usage.completion_tokens };
    }
    const toolCalls = [];
    const ids = new Set<string>();
    for (const [index, call] of [...calls].sort(([a], [b]) => a - b)) {
      if (
        index !== toolCalls.length ||
        !call.id.trim() ||
        !/^[a-zA-Z0-9_-]+$/.test(call.name) ||
        ids.has(call.id)
      )
        return yield* Fail.fail(new ProviderError(422, "Invalid assembled tool call"));
      ids.add(call.id);
      toolCalls.push(call);
    }
    return { text, toolCalls, usage };
  }).pipe(Resource.run);

export const chatCompletions = (options: Options) =>
  Model.handle({
    onOp: (req, resume) =>
      complete(options, req)
        .pipe(
          Retry.run(
            options.retry ?? {
              times: 3,
              delay: (n) => 500 * 2 ** n,
              while: (e) => e instanceof ProviderError && (e.status === 429 || e.status >= 500),
            },
          ),
        )
        .flatMap(resume),
  });

export const Deepseek = (options: Partial<Options> = {}) => {
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set");
  return chatCompletions({
    url: "https://api.deepseek.com/chat/completions",
    model: "deepseek-chat",
    ...options,
    apiKey,
  });
};

export const OpenAI = (options: Partial<Options> = {}) => {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  return chatCompletions({
    url: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    ...options,
    apiKey,
  });
};
