export async function* events<T = unknown>(body: ReadableStream): AsyncGenerator<T> {
  let buffer = "";
  let data = "";
  // A CR ends a line on its own, and eats the LF of a CRLF that the next chunk may carry.
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
        const payload = data.slice(0, -1);
        data = "";
        if (payload === "[DONE]") return;
        if (payload !== "") yield JSON.parse(payload) as T;
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
}
