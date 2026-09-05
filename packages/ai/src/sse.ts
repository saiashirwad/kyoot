/** Frame SSE data fields. JSON and provider protocol decoding belong to the consumer. */
export async function* frames(body: ReadableStream, signal?: AbortSignal): AsyncGenerator<string> {
  let buffer = "";
  let data = "";
  // A CR ends a line on its own, and eats the LF of a CRLF that the next chunk may carry.
  let skipLf = false;
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let cancelled = false;
  const close = async () => {
    if (cancelled) return;
    cancelled = true;
    await reader.cancel().catch(() => {});
  };
  const cancel = () => void close();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) return;
      buffer += chunk;
      let from = 0;
      while (from < buffer.length) {
        if (skipLf) {
          skipLf = false;
          if (buffer[from] === "\n" && ++from === buffer.length) break;
        }
        const cr = buffer.indexOf("\r", from);
        const lf = buffer.indexOf("\n", from);
        if (cr < 0 && lf < 0) break;
        skipLf = cr >= 0 && (lf < 0 || cr < lf);
        const end = skipLf ? cr : lf;
        const line = buffer.slice(from, end);
        from = end + 1;
        if (line === "") {
          const payload = data.slice(0, -1);
          data = "";
          if (payload === "[DONE]") return;
          if (payload !== "") yield payload;
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          if ((colon < 0 ? line : line.slice(0, colon)) === "data") {
            const value = colon < 0 ? "" : line.slice(colon + 1);
            data += `${value.startsWith(" ") ? value.slice(1) : value}\n`;
          }
        }
      }
      buffer = buffer.slice(from);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    await close();
    reader.releaseLock();
  }
}

/** Decode framed SSE data as JSON for callers that only need parsed events. */
export async function* events(body: ReadableStream, signal?: AbortSignal): AsyncGenerator<unknown> {
  for await (const payload of frames(body, signal)) yield JSON.parse(payload) as unknown;
}
