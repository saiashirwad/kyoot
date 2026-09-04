export interface Message {
  /** The `event:` field, or `"message"` when the event carried none. */
  readonly event: string;
  /** The `data:` lines joined with newlines, without the trailing one. */
  readonly data: string;
  /** The last `id:` seen on the stream, which persists across events. */
  readonly id: string;
}

/**
 * A WHATWG event stream parser.
 *
 * Lines end with CRLF, CR, or LF, a line starting with `:` is a comment, and a
 * blank line dispatches the event. Data left over when the stream ends is
 * discarded, as the spec requires.
 */
export async function* messages(body: ReadableStream): AsyncGenerator<Message> {
  let buffer = "";
  let event = "";
  let data = "";
  let id = "";
  // A CR ends a line on its own, and swallows the LF of a CRLF that may only
  // arrive with the next chunk.
  let skipLf = false;
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
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
        if (data !== "") yield { event: event || "message", data: data.slice(0, -1), id };
        event = "";
        data = "";
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const raw = colon < 0 ? "" : line.slice(colon + 1);
        const value = raw.startsWith(" ") ? raw.slice(1) : raw;
        if (field === "data") data += `${value}\n`;
        else if (field === "event") event = value;
        else if (field === "id" && !value.includes("\0")) id = value;
      }
    }
    buffer = buffer.slice(from);
  }
}

/** The JSON payloads of an event stream, up to the OpenAI `[DONE]` sentinel. */
export async function* events<T = unknown>(body: ReadableStream): AsyncGenerator<T> {
  for await (const { data } of messages(body)) {
    if (data === "") continue;
    if (data === "[DONE]") return;
    yield JSON.parse(data) as T;
  }
}
