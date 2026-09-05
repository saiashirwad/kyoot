import { Async, Fail, Kyoot, Resource, Retry } from "kyoot";
import { makeHandler } from "kyoot/internal";
import { Model, type Message, type Request, type ToolCall } from "./model.ts";
import { frames } from "./sse.ts";
import * as Events from "./events.ts";

export class ProviderError {
  readonly _tag = "ProviderError";
  readonly status: number;
  readonly message: string;
  /** True once text from this attempt reached the caller. Such an attempt must not retry. */
  readonly emitted: boolean;
  constructor(status: number, message: string, emitted = false) {
    this.status = status;
    this.message = message;
    this.emitted = emitted;
  }
}

export interface Options {
  readonly url: string;
  readonly model: string;
  readonly apiKey: string;
  readonly retry?: Retry.Policy;
}

interface ToolCallPart {
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: string;
}

interface Chunk {
  readonly content?: string | null;
  readonly toolCalls: readonly ToolCallPart[];
  readonly usage?: { readonly input: number; readonly output: number };
}

interface CallState {
  id?: string;
  name: string;
  arguments: string;
  argumentsSeen: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const field = (value: Record<string, unknown>, name: string) => value[name];

const protocol = (status: number, message: string): never => {
  throw new ProviderError(status, `invalid provider response: ${message}`);
};

const record = (value: unknown, name: string, status: number): Record<string, unknown> =>
  isRecord(value) ? value : protocol(status, `${name} must be an object`);

const array = (value: unknown, name: string, status: number): unknown[] =>
  Array.isArray(value) ? value : protocol(status, `${name} must be an array`);

const tokenCount = (value: unknown, name: string, status: number): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : protocol(status, `${name} must be a non-negative integer`);

const decodeJson = (payload: string, status: number): unknown => {
  try {
    return JSON.parse(payload) as unknown;
  } catch (error) {
    return protocol(status, `invalid JSON: ${errorMessage(error)}`);
  }
};

/** Decode the provider's untrusted JSON payload into the subset this adapter supports. */
const decodeChunk = (payload: unknown, status: number): Chunk => {
  const chunk = record(payload, "chunk", status);
  const rawChoices = array(field(chunk, "choices"), "choices", status);
  if (rawChoices.length > 1) protocol(status, "only one streamed choice is supported");

  let content: string | null | undefined;
  const toolCalls: ToolCallPart[] = [];
  if (rawChoices.length === 1) {
    const choice = record(rawChoices[0], "choice", status);
    const delta = field(choice, "delta");
    const decodedDelta = record(delta, "choice.delta", status);

    const rawContent = field(decodedDelta, "content");
    if (rawContent !== undefined && rawContent !== null && typeof rawContent !== "string")
      protocol(status, "choice.delta.content must be a string or null");
    content = rawContent as string | null | undefined;

    const rawCalls = field(decodedDelta, "tool_calls");
    if (rawCalls !== undefined) {
      for (const rawCall of array(rawCalls, "choice.delta.tool_calls", status)) {
        const decodedCall = record(rawCall, "tool call", status);
        const rawIndex = field(decodedCall, "index");
        const index =
          typeof rawIndex === "number" && Number.isSafeInteger(rawIndex) && rawIndex >= 0
            ? rawIndex
            : protocol(status, "tool call index must be a non-negative integer");
        const id = field(decodedCall, "id");
        if (id !== undefined && (typeof id !== "string" || id.length === 0))
          protocol(status, "tool call id must be a non-empty string");
        const type = field(decodedCall, "type");
        if (type !== undefined && type !== "function")
          protocol(status, "tool call type must be 'function'");
        const fn = record(field(decodedCall, "function"), "tool call function", status);
        const name = field(fn, "name");
        if (name !== undefined && (typeof name !== "string" || name.length === 0))
          protocol(status, "tool call function.name must be a non-empty string");
        const arguments_ = field(fn, "arguments");
        if (arguments_ !== undefined && typeof arguments_ !== "string")
          protocol(status, "tool call function.arguments must be a string");
        toolCalls.push({
          index,
          id: id as string | undefined,
          name: name as string | undefined,
          arguments: arguments_ as string | undefined,
        });
      }
    }
  }

  const rawUsage = field(chunk, "usage");
  let usage: Chunk["usage"];
  if (rawUsage !== undefined && rawUsage !== null) {
    const decodedUsage = record(rawUsage, "usage", status);
    usage = {
      input: tokenCount(field(decodedUsage, "prompt_tokens"), "usage.prompt_tokens", status),
      output: tokenCount(
        field(decodedUsage, "completion_tokens"),
        "usage.completion_tokens",
        status,
      ),
    };
  }
  if (rawChoices.length === 0 && usage === undefined)
    protocol(status, "chunk must contain a choice or usage");

  return { content, toolCalls, usage };
};

const appendToolCall = (calls: CallState[], part: ToolCallPart, status: number) => {
  if (part.index > calls.length)
    protocol(status, `tool call index ${part.index} skips an earlier call`);
  const call =
    calls[part.index] ??
    (calls[part.index] = { id: undefined, name: "", arguments: "", argumentsSeen: false });
  if (part.id !== undefined) {
    if (call.id !== undefined && call.id !== part.id)
      protocol(status, `tool call ${part.index} changed its id`);
    call.id = part.id;
  }
  if (part.name !== undefined) call.name += part.name;
  if (part.arguments !== undefined) {
    call.arguments += part.arguments;
    call.argumentsSeen = true;
  }
};

const finishToolCalls = (calls: readonly CallState[], status: number): readonly ToolCall[] =>
  calls.map((call, index) => {
    if (call.id === undefined)
      return protocol(
        status,
        `tool call ${index} ended before its id, name, and arguments were complete`,
      );
    if (call.name.length === 0 || !call.argumentsSeen)
      return protocol(
        status,
        `tool call ${index} ended before its id, name, and arguments were complete`,
      );
    return { id: call.id, name: call.name, arguments: call.arguments };
  });

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

const errorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
};

const complete = ({ url, model, apiKey }: Options, req: Request, markEmitted: () => void) =>
  Kyoot.gen(function* () {
    const res = yield* Async.fromPromise((signal) =>
      fetch(url, {
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
    );
    if (!res.ok) {
      const message = yield* Async.fromPromise(() => res.text());
      yield* Fail.fail(new ProviderError(res.status, message));
    }
    if (res.body === null)
      yield* Fail.fail(new ProviderError(res.status, "response body is missing"));

    const stream = yield* Resource.acquire(
      () => {
        const controller = new AbortController();
        // SSE framing yields text. Decode JSON and validate the provider protocol here.
        const iterator = frames(res.body!, controller.signal)[Symbol.asyncIterator]();
        let closing: Promise<void> | undefined;
        return {
          iterator,
          close: () => {
            controller.abort();
            return (closing ??= Promise.resolve(iterator.return?.(undefined)).then(
              () => undefined,
            ));
          },
        };
      },
      (stream) =>
        Async.fromPromise(async () => {
          await stream.close();
        }),
    );
    let text = "";
    let usage = { input: 0, output: 0 };
    const calls: CallState[] = [];
    while (true) {
      const r = yield* Async.fromPromise((signal) => {
        const stop = () => void stream.close().catch(() => {});
        signal.addEventListener("abort", stop, { once: true });
        return stream.iterator.next().finally(() => signal.removeEventListener("abort", stop));
      });
      if (r.done) break;
      const chunk = decodeChunk(decodeJson(r.value, res.status), res.status);
      const { content } = chunk;
      if (content) {
        text += content;
        markEmitted();
        yield* Events.emit({ type: "text", text: content });
      }
      for (const call of chunk.toolCalls) appendToolCall(calls, call, res.status);
      if (chunk.usage) usage = chunk.usage;
    }
    return { text, toolCalls: finishToolCalls(calls, res.status), usage };
  }).pipe(Resource.run);

const attempt = (options: Options, req: Request) => {
  let emitted = false;
  return makeHandler(
    "ai/provider-attempt",
    complete(options, req, () => (emitted = true)),
    {
      onOp: () => {
        throw new Error("unreachable");
      },
      onDefect: (error) =>
        Fail.fail(
          error instanceof ProviderError
            ? new ProviderError(error.status, error.message, emitted)
            : new ProviderError(0, errorMessage(error), emitted),
        ),
    },
  );
};

export const chatCompletions = (options: Options) =>
  Model.handle({
    onOp: (req, resume) => {
      const retry =
        options.retry ??
        ({
          retries: 3,
          delay: (n: number) => 500 * 2 ** n,
          while: (e: unknown) =>
            e instanceof ProviderError && (e.status === 429 || e.status >= 500),
        } satisfies Retry.Policy);
      return attempt(options, req)
        .pipe(
          Retry.run({
            ...retry,
            // A retried response would append to text that already reached the caller.
            while: (error) =>
              !(error instanceof ProviderError && error.emitted) && (retry.while?.(error) ?? true),
          }),
        )
        .flatMap(resume);
    },
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
