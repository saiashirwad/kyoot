import assert from "node:assert/strict";
import { test } from "node:test";
import { events, messages, type Message } from "../src/sse.ts";

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

const collectMessages = async (chunks: (string | Uint8Array)[]) => {
  const out: Message[] = [];
  for await (const m of messages(stream(chunks))) out.push(m);
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

test("sse: a CRLF split across chunks is one line ending", async () => {
  assert.deepEqual(await collect(['data: {"n":1}\r', "\n\r\n"]), [{ n: 1 }]);
  assert.deepEqual(await collect(['data: {"a":1}\r\n\r', '\ndata: {"b":2}\r\n\r\n']), [
    { a: 1 },
    { b: 2 },
  ]);
});

test("sse: a lone CR at the end of a chunk still ends a line", async () => {
  assert.deepEqual(await collect(['data: {"n":1}\r', '\rdata: {"m":2}\r\r']), [{ n: 1 }, { m: 2 }]);
});

test("sse: ignores comment lines", async () => {
  assert.deepEqual(await collect([': keepalive\ndata: {"n":1}\n\n']), [{ n: 1 }]);
  assert.deepEqual(await collect([':\n:ping\n\ndata: {"n":1}\n\n']), [{ n: 1 }]);
});

test("sse: keeps data when the event has other fields", async () => {
  assert.deepEqual(await collect(['event: message\ndata: {"n":1}\n\n']), [{ n: 1 }]);
  assert.deepEqual(await collect(['id: 7\nretry: 500\ndata: {"n":1}\n\n']), [{ n: 1 }]);
  assert.deepEqual(await collect(['data: {"n":1}\nevent: completion\n\n']), [{ n: 1 }]);
});

test("sse: joins several data lines with newlines", async () => {
  assert.deepEqual(await collect(['data: {"n":\ndata: 1}\n\n']), [{ n: 1 }]);
  assert.deepEqual(await collectMessages(["data: a\ndata: b\n\n"]), [
    { event: "message", data: "a\nb", id: "" },
  ]);
});

test("sse: reports the event type and carries the last id forward", async () => {
  const out = await collectMessages([
    "event: delta\nid: 1\ndata: a\n\ndata: b\n\nid: 2\ndata: c\n\n",
  ]);
  assert.deepEqual(out, [
    { event: "delta", data: "a", id: "1" },
    { event: "message", data: "b", id: "1" },
    { event: "message", data: "c", id: "2" },
  ]);
});

test("sse: strips one space after the field name and nothing else", async () => {
  assert.deepEqual(await collectMessages(["data:a\ndata:  b\ndata:\td\n\n"]), [
    { event: "message", data: "a\n b\n\td", id: "" },
  ]);
});

test("sse: a field with no colon has an empty value", async () => {
  assert.deepEqual(await collectMessages(["data\ndata: a\n\n"]), [
    { event: "message", data: "\na", id: "" },
  ]);
});

test("sse: dispatches blank data but yields no JSON for it", async () => {
  assert.deepEqual(await collectMessages(["data:\n\ndata: a\n\n"]), [
    { event: "message", data: "", id: "" },
    { event: "message", data: "a", id: "" },
  ]);
  assert.deepEqual(await collect(['data:\n\ndata: {"n":1}\n\n']), [{ n: 1 }]);
});

test("sse: a blank line without data dispatches nothing and resets the event type", async () => {
  assert.deepEqual(await collectMessages(["event: delta\n\ndata: a\n\n"]), [
    { event: "message", data: "a", id: "" },
  ]);
});

test("sse: discards data that the stream never terminates with a blank line", async () => {
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

test("sse: yields nothing for an empty stream", async () => {
  assert.deepEqual(await collect([]), []);
  assert.deepEqual(await collect(["\n\n\r\n\r\n"]), []);
});
