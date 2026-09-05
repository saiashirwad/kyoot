import assert from "node:assert/strict";
import { test } from "node:test";
import { Async, Clock, Emit, Fail, Kyoot } from "kyoot";
import { chatCompletions, Model, ProviderError, type Request } from "@kyoot/ai";

const options = { url: "https://example.test/chat", model: "test", apiKey: "secret" };
const request: Request = { messages: [{ role: "user", content: "hello" }] };
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

const response = (chunks: string[], status = 200) => {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status },
  );
};

test("chatCompletions streams text, a split tool call, and usage", async () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = async () =>
    response([
      event({
        choices: [
          {
            delta: {
              content: "Hello ",
              tool_calls: [
                { index: 0, id: "call-1", function: { name: "wea", arguments: '{"city"' } },
              ],
            },
          },
        ],
      }),
      event({
        choices: [
          {
            delta: {
              content: "there",
              tool_calls: [{ index: 0, function: { name: "ther", arguments: ':"Pune"}' } }],
            },
          },
        ],
      }),
      event({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
      "data: [DONE]\n\n",
    ]);

  try {
    const [completion, events] = await Kyoot.runPromise(
      Model(request).pipe(chatCompletions(options), Emit.collect, Fail.orThrow),
    );
    assert.deepEqual(completion, {
      text: "Hello there",
      toolCalls: [{ id: "call-1", name: "weather", arguments: '{"city":"Pune"}' }],
      usage: { input: 7, output: 3 },
    });
    assert.deepEqual(events, [
      { type: "text", text: "Hello " },
      { type: "text", text: "there" },
    ]);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("chatCompletions retries 429 with virtual backoff", async () => {
  const fetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response("slow down", { status: 429 });
    return response([event({ choices: [{ delta: { content: "ok" } }] }), "data: [DONE]\n\n"]);
  };

  try {
    const r = await Kyoot.runPromise(
      Model(request).pipe(chatCompletions(options), Emit.discard, Fail.orThrow, Clock.virtual),
    );
    assert.deepEqual(r, [{ text: "ok", toolCalls: [], usage: { input: 0, output: 0 } }, 500]);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("chatCompletions does not retry 401", async () => {
  const fetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("bad key", { status: 401 });
  };

  try {
    const [r, elapsed] = await Kyoot.runPromise(
      Model(request).pipe(chatCompletions(options), Emit.discard, Fail.run, Clock.virtual),
    );
    assert.equal(r.ok, false);
    assert.ok(
      !r.ok &&
        r.cause._tag === "Fail" &&
        r.cause.error instanceof ProviderError &&
        r.cause.error.status === 401 &&
        r.cause.error.message === "bad key",
    );
    assert.equal(elapsed, 0);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("chatCompletions turns network, body, and malformed stream failures into ProviderError", async () => {
  const fetch = globalThis.fetch;
  const failures: Array<() => Promise<Response>> = [
    async () => {
      throw new Error("network down");
    },
    async () => new Response(null),
    async () => response(["data: {not json}\n\n"]),
  ];
  try {
    for (const fail of failures) {
      globalThis.fetch = fail;
      const result = await Kyoot.runPromise(
        Model(request).pipe(chatCompletions(options), Emit.discard, Fail.run),
      );
      assert.ok(
        !result.ok && result.cause._tag === "Fail" && result.cause.error instanceof ProviderError,
      );
    }
  } finally {
    globalThis.fetch = fetch;
  }
});

test("chatCompletions rejects malformed provider chunk fields before emitting", async () => {
  const fetch = globalThis.fetch;
  const malformed: readonly [string, unknown][] = [
    ["a non-object chunk", []],
    ["a non-array choices field", { choices: {} }],
    ["an empty chunk", { choices: [] }],
    ["a non-string content field", { choices: [{ delta: { content: 42 } }] }],
    ["invalid usage counts", { choices: [], usage: { prompt_tokens: -1, completion_tokens: 1.5 } }],
    [
      "an invalid tool call index",
      { choices: [{ delta: { tool_calls: [{ index: -1, function: { name: "weather" } }] } }] },
    ],
    [
      "an invalid tool call field",
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 42 } }] } }] },
    ],
  ];
  try {
    for (const [name, chunk] of malformed) {
      globalThis.fetch = async () => response([event(chunk), "data: [DONE]\n\n"]);
      const result = await Kyoot.runPromise(
        Model(request).pipe(chatCompletions(options), Emit.discard, Fail.run),
      );
      assert.ok(
        !result.ok &&
          result.cause._tag === "Fail" &&
          result.cause.error instanceof ProviderError &&
          result.cause.error.status === 200 &&
          !result.cause.error.emitted,
        name,
      );
    }
  } finally {
    globalThis.fetch = fetch;
  }
});

test("chatCompletions rejects incomplete assembled tool calls", async () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = async () =>
    response([
      event({
        choices: [
          { delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "weather" } }] } },
        ],
      }),
      "data: [DONE]\n\n",
    ]);
  try {
    const result = await Kyoot.runPromise(
      Model(request).pipe(chatCompletions(options), Emit.discard, Fail.run),
    );
    assert.ok(
      !result.ok &&
        result.cause._tag === "Fail" &&
        result.cause.error instanceof ProviderError &&
        result.cause.error.message.includes("ended before"),
    );
  } finally {
    globalThis.fetch = fetch;
  }
});

test("chatCompletions maps a read failure and does not retry after text has streamed", async () => {
  const fetch = globalThis.fetch;
  let calls = 0;
  let breakStream = () => {};
  globalThis.fetch = async () => {
    calls++;
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(event({ choices: [{ delta: { content: "first" } }] })));
          breakStream = () => controller.error(new Error("connection lost"));
        },
      }),
    );
  };
  try {
    const emitted: unknown[] = [];
    const result = await Kyoot.runPromise(
      Model(request).pipe(
        chatCompletions(options),
        Emit.forEach((event) => {
          emitted.push(event);
          breakStream();
        }),
        Fail.run,
      ),
    );
    assert.ok(
      !result.ok &&
        result.cause._tag === "Fail" &&
        result.cause.error instanceof ProviderError &&
        result.cause.error.emitted,
    );
    assert.deepEqual(emitted, [{ type: "text", text: "first" }]);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("chatCompletions does not retry a malformed chunk after text has streamed", async () => {
  const fetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return response([
      event({ choices: [{ delta: { content: "first" } }] }),
      event({
        choices: [{ delta: { tool_calls: [{ index: 1, function: { name: "weather" } }] } }],
      }),
      "data: [DONE]\n\n",
    ]);
  };
  try {
    const result = await Kyoot.runPromise(
      Model(request).pipe(
        chatCompletions({ ...options, retry: { times: 3, delay: 0, while: () => true } }),
        Emit.discard,
        Fail.run,
      ),
    );
    assert.ok(
      !result.ok &&
        result.cause._tag === "Fail" &&
        result.cause.error instanceof ProviderError &&
        result.cause.error.emitted,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("interrupting a response closes its stream iterator", async () => {
  const fetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        pull() {},
        cancel() {
          cancelled = true;
        },
      }),
    );
  try {
    const result = await Kyoot.runPromise(
      Async.race(
        Model(request).pipe(chatCompletions(options), Emit.discard, Fail.orThrow),
        Clock.sleep(1),
      ),
    );
    assert.equal(result, undefined);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = fetch;
  }
});
