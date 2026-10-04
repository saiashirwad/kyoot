import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock, Emit, Fail, InterruptedError, Kyoot, runFiber } from "kyoot";
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

test("chatCompletions cancels an open body after malformed calls", async () => {
  const fetch = globalThis.fetch;
  let cancelled = 0;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          event({
            choices: [
              {
                delta: {
                  tool_calls: [{ index: -1, id: "a", function: { name: "tool", arguments: "{}" } }],
                },
              },
            ],
          }),
        ),
      );
    },
    cancel() {
      cancelled++;
    },
  });
  globalThis.fetch = async () => new Response(body);
  try {
    const result = await Kyoot.runPromise(
      Model(request).pipe(chatCompletions(options), Emit.discard, Fail.run),
    );
    assert.ok(!result.ok && result.cause._tag === "Fail");
    assert.equal(cancelled, 1);
    assert.equal(body.locked, false);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("chatCompletions interruption cancels a pending stream read", { timeout: 2000 }, async () => {
  const fetch = globalThis.fetch;
  let cancelled = 0;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(event({ choices: [{ delta: { content: "partial" } }] })),
      );
    },
    cancel() {
      cancelled++;
    },
  });
  globalThis.fetch = async () => new Response(body);
  const fiber = runFiber(
    Model(request).pipe(
      chatCompletions(options),
      Emit.intercept<unknown>()((value, next) => {
        started();
        return next(value);
      }),
      Emit.discard,
      Fail.orThrow,
    ),
  );
  const rejected = assert.rejects(fiber.promise, InterruptedError);
  try {
    await ready;
    fiber.interrupt();
    await rejected;
    assert.equal(cancelled, 1);
    assert.equal(body.locked, false);
  } finally {
    fiber.interrupt();
    globalThis.fetch = fetch;
  }
});

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

for (const [name, chunks] of [
  ...(
    [
      [
        "oversized call index",
        [{ index: Number.MAX_SAFE_INTEGER, id: "a", function: { name: "tool", arguments: "{}" } }],
      ],
      [
        "missing preceding call index",
        [{ index: 1, id: "a", function: { name: "tool", arguments: "{}" } }],
      ],
      [
        "non-string name fragment",
        [{ index: 0, id: "a", function: { name: 123, arguments: "{}" } }],
      ],
      [
        "non-string argument fragment",
        [{ index: 0, id: "a", function: { name: "tool", arguments: {} } }],
      ],
      [
        "conflicting call ids",
        [
          { index: 0, id: "a", function: { name: "tool", arguments: "{}" } },
          { index: 0, id: "b" },
        ],
      ],
      [
        "duplicate assembled call ids",
        [
          { index: 0, id: "a", function: { name: "tool", arguments: "{}" } },
          { index: 1, id: "a", function: { name: "other", arguments: "{}" } },
        ],
      ],
    ] satisfies [string, unknown[]][]
  ).map(([name, calls]): [string, string[]] => [
    name,
    [event({ choices: [{ delta: { tool_calls: calls } }] }), "data: [DONE]\n\n"],
  ]),
  ["non-object chunk", [event(null), "data: [DONE]\n\n"]],
  ["non-array choices", [event({ choices: {} }), "data: [DONE]\n\n"]],
  ["null choice", [event({ choices: [null] }), "data: [DONE]\n\n"]],
  ["non-object delta", [event({ choices: [{ delta: "bad" }] }), "data: [DONE]\n\n"]],
  [
    "non-array tool calls",
    [event({ choices: [{ delta: { tool_calls: {} } }] }), "data: [DONE]\n\n"],
  ],
  ["null tool call", [event({ choices: [{ delta: { tool_calls: [null] } }] }), "data: [DONE]\n\n"]],
  ["non-string content", [event({ choices: [{ delta: { content: 42 } }] }), "data: [DONE]\n\n"]],
  [
    "invalid usage",
    [
      event({ choices: [], usage: { prompt_tokens: -1, completion_tokens: "2" } }),
      "data: [DONE]\n\n",
    ],
  ],
  ["truncated stream", [event({ choices: [{ delta: { content: "partial" } }] })]],
  [
    "missing call id",
    [
      event({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { name: "tool", arguments: "{}" } }] } },
        ],
      }),
      "data: [DONE]\n\n",
    ],
  ],
  [
    "missing call name",
    [
      event({
        choices: [
          { delta: { tool_calls: [{ index: 0, id: "a", function: { arguments: "{}" } }] } },
        ],
      }),
      "data: [DONE]\n\n",
    ],
  ],
  [
    "invalid call index",
    [
      event({
        choices: [
          {
            delta: {
              tool_calls: [{ index: -1, id: "a", function: { name: "tool", arguments: "{}" } }],
            },
          },
        ],
      }),
      "data: [DONE]\n\n",
    ],
  ],
] satisfies [string, string[]][]) {
  test(`chatCompletions rejects ${name}`, async () => {
    const fetch = globalThis.fetch;
    globalThis.fetch = async () => response(chunks);
    try {
      const result = await Kyoot.runPromise(
        Model(request).pipe(chatCompletions(options), Emit.discard, Fail.run),
      );
      assert.ok(
        !result.ok && result.cause._tag === "Fail" && result.cause.error instanceof ProviderError,
      );
    } finally {
      globalThis.fetch = fetch;
    }
  });
}
