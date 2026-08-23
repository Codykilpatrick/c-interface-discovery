/**
 * A stand-in for vLLM's OpenAI-compatible endpoint.
 *
 * The real server is on an airgapped network and unavailable during
 * development, so every client behaviour is pinned against replayed wire format
 * here. Chunk boundaries are controllable because that is where SSE parsing
 * actually breaks: a network read can split mid-line or mid-UTF-8-sequence.
 */

export interface MockCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
}

/** Build an SSE response whose body arrives as the given raw chunks, verbatim. */
export function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** Build an SSE response from raw bytes, for splitting inside a UTF-8 sequence. */
export function sseResponseBytes(chunks: Uint8Array[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

/** One `data:` frame in OpenAI streaming format. */
export function deltaFrame(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    model: 'google/gemma-4-26B-A4B-it',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

export const DONE_FRAME = 'data: [DONE]\n\n';

/** A complete non-streaming chat completion body. */
export function completionBody(message: Record<string, unknown>, finishReason = 'stop') {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    model: 'google/gemma-4-26B-A4B-it',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

export function modelsBody(models: { id: string; max_model_len?: number }[]) {
  return {
    object: 'list',
    data: models.map((m) => ({ object: 'model', owned_by: 'vllm', ...m })),
  };
}

export interface MockServer {
  calls: MockCall[];
  /** Queue a response for the next matching request; falls back to `onRequest`. */
  enqueue(match: string, response: Response | (() => Response)): void;
  onRequest?: (call: MockCall) => Response | Promise<Response>;
  restore(): void;
  lastBody(): Record<string, unknown>;
}

/** Install a `globalThis.fetch` stub. Call `restore()` in an afterEach. */
export function installMockServer(): MockServer {
  const original = globalThis.fetch;
  const calls: MockCall[] = [];
  const queue: { match: string; response: Response | (() => Response) }[] = [];

  const server: MockServer = {
    calls,
    enqueue(match, response) {
      queue.push({ match, response });
    },
    restore() {
      globalThis.fetch = original;
    },
    lastBody() {
      return (calls[calls.length - 1]?.body ?? {}) as Record<string, unknown>;
    },
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call: MockCall = {
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);

    // Real fetch rejects with AbortError, not signal.reason (a TimeoutError).
    const signal = init?.signal;
    const abortErr = () => new DOMException('The operation was aborted.', 'AbortError');
    if (signal?.aborted) throw abortErr();

    const work = (async (): Promise<Response> => {
      const idx = queue.findIndex((q) => url.includes(q.match));
      if (idx !== -1) {
        const [entry] = queue.splice(idx, 1);
        return typeof entry.response === 'function' ? entry.response() : entry.response;
      }
      if (server.onRequest) return server.onRequest(call);
      throw new TypeError('Failed to fetch');
    })();

    if (!signal) return work;
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(abortErr());
      signal.addEventListener('abort', onAbort, { once: true });
      work.then(
        (r) => { signal.removeEventListener('abort', onAbort); resolve(r); },
        (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
      );
    });
  }) as typeof fetch;

  return server;
}
