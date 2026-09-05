import assert from "node:assert/strict";
import { test } from "node:test";
import { events } from "../src/sse.ts";

const stream = (chunks: (string | Uint8Array)[]) =>
  new ReadableStream({
    start(controller) {
      for (const c of chunks)
        controller.enqueue(typeof c === "string" ? new TextEncoder().encode(c) : c);
      controller.close();
    },
  });

const collect = async (chunks: (string | Uint8Array)[]) => {
  const out: unknown[] = [];
  for await (const e of events(stream(chunks))) out.push(e);
  return out;
};

test("sse: parses data events split across chunks and stops at [DONE]", async () => {
  const out = await collect([
    'data: {"a":1}\n\nda',
    'ta: {"b":2}\n\n',
    'data: [DONE]\n\ndata: {"c":3}\n\n',
  ]);
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }]);
});

test("sse: ends lines on CRLF, CR, and LF", async () => {
  assert.deepEqual(await collect(['data: {"n":1}\r\n\r\n']), [{ n: 1 }]);
  assert.deepEqual(await collect(['data: {"n":1}\r\r']), [{ n: 1 }]);
  assert.deepEqual(await collect(['data: {"n":1}\n\n']), [{ n: 1 }]);
});

test("sse: a CR at the end of a chunk ends one line, CRLF or not", async () => {
  assert.deepEqual(await collect(['data: {"n":1}\r', "\n\r\n"]), [{ n: 1 }]);
  assert.deepEqual(await collect(['data: {"n":1}\r', '\rdata: {"m":2}\r\r']), [{ n: 1 }, { m: 2 }]);
});

test("sse: ignores comment lines", async () => {
  assert.deepEqual(await collect([': keepalive\ndata: {"n":1}\n\n']), [{ n: 1 }]);
  assert.deepEqual(await collect([':\n:ping\n\ndata: {"n":1}\n\n']), [{ n: 1 }]);
});

test("sse: keeps the data of an event that has other fields", async () => {
  assert.deepEqual(await collect(['event: message\ndata: {"n":1}\n\n']), [{ n: 1 }]);
  assert.deepEqual(await collect(['id: 7\nretry: 500\ndata: {"n":1}\n\n']), [{ n: 1 }]);
  assert.deepEqual(await collect(['data: {"n":1}\nevent: completion\n\n']), [{ n: 1 }]);
});

test("sse: joins data lines with newlines, and a bare data line adds one", async () => {
  assert.deepEqual(await collect(['data: {"n":\ndata: 1}\n\n']), [{ n: 1 }]);
  assert.deepEqual(await collect(['data: {"n":\ndata\ndata: 1}\n\n']), [{ n: 1 }]);
});

test("sse: yields nothing for an event with no data", async () => {
  assert.deepEqual(await collect(['data:\n\ndata: {"n":1}\n\n']), [{ n: 1 }]);
  assert.deepEqual(await collect([]), []);
  assert.deepEqual(await collect(["\n\n\r\n\r\n"]), []);
});

test("sse: discards data the stream never terminates with a blank line", async () => {
  assert.deepEqual(await collect(['data: {"a":1}\n\ndata: {"b":2}\n']), [{ a: 1 }]);
  assert.deepEqual(await collect(['data: {"a":1}\n\ndata: {"b":2}\r']), [{ a: 1 }]);
});

test("sse: stops at [DONE] with or without the leading space", async () => {
  assert.deepEqual(await collect(['data:[DONE]\n\ndata: {"n":1}\n\n']), []);
  assert.deepEqual(await collect(['data: {"a":1}\r\n\r\ndata: [DONE]\r\n\r\n']), [{ a: 1 }]);
});

test("sse: decodes a multi-byte character split across chunks", async () => {
  const bytes = new TextEncoder().encode('data: {"s":"€"}\n\n');
  const split = bytes.indexOf(0xe2) + 1;
  assert.deepEqual(await collect([bytes.slice(0, split), bytes.slice(split)]), [{ s: "€" }]);
});
