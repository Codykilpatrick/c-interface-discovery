/**
 * Server-Sent Events parsing for the OpenAI streaming wire format.
 *
 * Isolated from the HTTP client so it can be tested exhaustively without a
 * server. The failure modes that matter are all about chunk boundaries: a
 * network read can split anywhere, including mid-line and mid-UTF-8-sequence,
 * and a parser that assumes one chunk equals one event drops tokens silently.
 */

/** Incremental SSE line assembler. Feed it decoded text; get back complete data payloads. */
export class SseParser {
  private buffer = '';

  /**
   * Feed a chunk of decoded text. Returns the `data:` payloads completed by this
   * chunk, in order. A trailing partial line is retained for the next call.
   */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];

    // Events are separated by newlines; a payload may span multiple `data:` lines.
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      // Strip a CR from CRLF endings.
      let line = this.buffer.slice(0, newlineIndex);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line === '') continue;        // event separator
      if (line.startsWith(':')) continue; // comment / keep-alive

      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      if (field !== 'data') continue;   // ignore event:, id:, retry:

      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      out.push(value);
    }
    return out;
  }

  /** Any payload left in a final line with no trailing newline. */
  flush(): string[] {
    if (this.buffer.trim() === '') {
      this.buffer = '';
      return [];
    }
    const remaining = this.buffer;
    this.buffer = '';
    return this.push(remaining + '\n');
  }
}

/**
 * Read a `fetch` body as decoded text chunks.
 *
 * `TextDecoder` with `{ stream: true }` is required: a chunk boundary can fall
 * inside a multi-byte character, and decoding each chunk independently would
 * emit a replacement character in the middle of a token.
 */
export async function* readTextChunks(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  try {
    for (;;) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released by an abort.
    }
  }
}
