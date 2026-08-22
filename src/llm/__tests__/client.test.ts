import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  accumulateToolCalls,
  chat,
  chatStream,
  collectStream,
  eventsFromChunk,
  listModels,
  parseChatResponse,
} from '../client';
import { DEFAULT_LLM_CONFIG, type LlmConfig } from '../config';
import { LlmError, type StreamEvent } from '../types';
import {
  DONE_FRAME, completionBody, deltaFrame, installMockServer,
  jsonResponse, modelsBody, sseResponse, textResponse,
} from './mockServer';

const config: LlmConfig = {
  ...DEFAULT_LLM_CONFIG,
  enabled: true,
  model: 'google/gemma-4-26B-A4B-it',
  baseUrl: '/llm',
};

let server: ReturnType<typeof installMockServer> | null = null;
afterEach(() => {
  server?.restore();
  server = null;
  vi.useRealTimers();
});

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

// ── Models ────────────────────────────────────────────────────────────────────

describe('listModels', () => {
  it('returns ids and the served context length', async () => {
    server = installMockServer();
    server.enqueue('/v1/models', jsonResponse(modelsBody([
      { id: 'google/gemma-4-26B-A4B-it', max_model_len: 262144 },
    ])));
    expect(await listModels(config)).toEqual([
      { id: 'google/gemma-4-26B-A4B-it', maxModelLen: 262144 },
    ]);
  });

  it('omits maxModelLen when the build does not report it', async () => {
    server = installMockServer();
    server.enqueue('/v1/models', jsonResponse(modelsBody([{ id: 'm' }])));
    expect(await listModels(config)).toEqual([{ id: 'm' }]);
  });

  it('sends no Authorization header when no key is configured', async () => {
    server = installMockServer();
    server.enqueue('/v1/models', jsonResponse(modelsBody([{ id: 'm' }])));
    await listModels(config);
    expect(server.calls[0].headers.Authorization).toBeUndefined();
  });

  it('sends a bearer token when a key is configured', async () => {
    server = installMockServer();
    server.enqueue('/v1/models', jsonResponse(modelsBody([{ id: 'm' }])));
    await listModels({ ...config, apiKey: '  secret  ' });
    expect(server.calls[0].headers.Authorization).toBe('Bearer secret');
  });

  it('reports an HTML error page from a proxy as an http error, not a parse crash', async () => {
    server = installMockServer();
    server.enqueue('/v1/models', textResponse('<html><body>404 Not Found</body></html>', 404));
    await expect(listModels(config)).rejects.toMatchObject({ kind: 'http', status: 404 });
  });

  it('surfaces an OpenAI-shaped error message', async () => {
    server = installMockServer();
    server.enqueue('/v1/models', jsonResponse({ error: { message: 'no api key' } }, 401));
    await expect(listModels(config)).rejects.toThrow('no api key');
  });

  it('rejects a malformed body', async () => {
    server = installMockServer();
    server.enqueue('/v1/models', jsonResponse({ object: 'list' }));
    await expect(listModels(config)).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('classifies a connection failure as a network error', async () => {
    server = installMockServer();
    await expect(listModels(config)).rejects.toMatchObject({ kind: 'network' });
  });
});

// ── Request assembly ──────────────────────────────────────────────────────────

describe('chat — request shape', () => {
  it('posts to the right path and carries model, temperature and cap', async () => {
    server = installMockServer();
    server.enqueue('/v1/chat/completions', jsonResponse(completionBody({ content: 'ok' })));
    await chat(config, { messages: [{ role: 'user', content: 'hi' }] });
    expect(server.calls[0].url).toBe('/llm/v1/chat/completions');
    expect(server.lastBody()).toMatchObject({
      model: 'google/gemma-4-26B-A4B-it',
      temperature: 0.2,
      max_tokens: 4000,
      stream: false,
    });
  });

  it('does not stream tool-call turns', async () => {
    // The whole point of the split strategy: vLLM's gemma4 tool parser is
    // unreliable in streaming mode, so tool turns go over the non-streaming path.
    server = installMockServer();
    server.enqueue('/v1/chat/completions', jsonResponse(completionBody({ content: '' })));
    await chat(config, {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: {} } }],
    });
    expect(server.lastBody().stream).toBe(false);
    expect(server.lastBody().tool_choice).toBe('auto');
  });

  it('passes tool_choice none through even with no tools, for the final prose turn', async () => {
    server = installMockServer();
    server.enqueue('/v1/chat/completions', jsonResponse(completionBody({ content: 'x' })));
    await chat(config, { messages: [{ role: 'user', content: 'hi' }], toolChoice: 'none' });
    expect(server.lastBody().tool_choice).toBe('none');
  });

  it('omits tool fields entirely when there are no tools', async () => {
    server = installMockServer();
    server.enqueue('/v1/chat/completions', jsonResponse(completionBody({ content: 'x' })));
    await chat(config, { messages: [{ role: 'user', content: 'hi' }] });
    expect(server.lastBody()).not.toHaveProperty('tools');
    expect(server.lastBody()).not.toHaveProperty('tool_choice');
  });

  it('disables thinking through chat_template_kwargs', async () => {
    server = installMockServer();
    server.enqueue('/v1/chat/completions', jsonResponse(completionBody({ content: 'x' })));
    await chat(config, { messages: [{ role: 'user', content: 'hi' }], thinking: 'off' });
    expect(server.lastBody().chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('leaves thinking alone on auto', async () => {
    server = installMockServer();
    server.enqueue('/v1/chat/completions', jsonResponse(completionBody({ content: 'x' })));
    await chat(config, { messages: [{ role: 'user', content: 'hi' }], thinking: 'auto' });
    expect(server.lastBody()).not.toHaveProperty('chat_template_kwargs');
  });

  it('uses response_format rather than the removed guided_json field', async () => {
    // guided_* was removed in vLLM v0.12.0; response_format is version-stable.
    server = installMockServer();
    server.enqueue('/v1/chat/completions', jsonResponse(completionBody({ content: '{}' })));
    await chat(config, {
      messages: [{ role: 'user', content: 'hi' }],
      responseFormat: { type: 'json_schema', json_schema: { name: 'p', schema: { type: 'object' } } },
    });
    expect(server.lastBody()).toHaveProperty('response_format');
    expect(server.lastBody()).not.toHaveProperty('guided_json');
  });

  it('refuses to send when disabled or unconfigured', async () => {
    server = installMockServer();
    await expect(chat({ ...config, enabled: false }, { messages: [] }))
      .rejects.toMatchObject({ kind: 'config' });
    await expect(chat({ ...config, model: '' }, { messages: [] }))
      .rejects.toMatchObject({ kind: 'config' });
    expect(server.calls).toHaveLength(0);
  });
});

// ── Response parsing ──────────────────────────────────────────────────────────

describe('parseChatResponse', () => {
  it('splits reasoning from content', () => {
    const r = parseChatResponse(completionBody({ content: 'answer', reasoning_content: 'thinking' }));
    expect(r.content).toBe('answer');
    expect(r.reasoningContent).toBe('thinking');
  });

  it('reads tool calls with string arguments', () => {
    const r = parseChatResponse(completionBody({
      content: null,
      tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'getStructLayout', arguments: '{"name":"ContactMsg"}' } }],
    }, 'tool_calls'));
    expect(r.toolCalls).toEqual([{
      id: 'call_a', type: 'function',
      function: { name: 'getStructLayout', arguments: '{"name":"ContactMsg"}' },
    }]);
    expect(r.finishReason).toBe('tool_calls');
  });

  it('re-serializes arguments that arrive as an object', () => {
    const r = parseChatResponse(completionBody({
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: { a: 1 } } }],
    }));
    expect(r.toolCalls[0].function.arguments).toBe('{"a":1}');
  });

  it('synthesizes an id when the parser omits one', () => {
    // vllm#42696: the gemma4 parser has been observed dropping id fields.
    const r = parseChatResponse(completionBody({
      tool_calls: [{ type: 'function', function: { name: 'f', arguments: '{}' } }],
    }));
    expect(r.toolCalls[0].id).toBe('call_0');
  });

  it('drops a tool call with no function name rather than emitting a broken one', () => {
    const r = parseChatResponse(completionBody({
      tool_calls: [{ id: 'c', type: 'function', function: { arguments: '{}' } }],
    }));
    expect(r.toolCalls).toEqual([]);
  });

  it('treats a null content with tool calls as empty text', () => {
    const r = parseChatResponse(completionBody({ content: null, tool_calls: [] }));
    expect(r.content).toBe('');
  });

  it('throws on a body with no choices', () => {
    expect(() => parseChatResponse({ choices: [] })).toThrow(LlmError);
  });
});

// ── Streaming ─────────────────────────────────────────────────────────────────

describe('chatStream', () => {
  it('yields content deltas in order and finishes', async () => {
    server = installMockServer();
    server.enqueue('/v1/chat/completions', sseResponse([
      deltaFrame({ role: 'assistant' }),
      deltaFrame({ content: 'Hello' }),
      deltaFrame({ content: ' world' }),
      deltaFrame({}, 'stop'),
      DONE_FRAME,
    ]));
    const events = await drain(chatStream(config, { messages: [{ role: 'user', content: 'hi' }] }));
    expect(events.filter((e) => e.type === 'content').map((e) => (e as { delta: string }).delta))
      .toEqual(['Hello', ' world']);
    expect(events[events.length - 1]).toMatchObject({ type: 'done' });
  });

  it('sets stream true and requests the event-stream content type', async () => {
    server = installMockServer();
    server.enqueue('/v1/chat/completions', sseResponse([deltaFrame({ content: 'x' }, 'stop'), DONE_FRAME]));
    await drain(chatStream(config, { messages: [{ role: 'user', content: 'hi' }] }));
    expect(server.lastBody().stream).toBe(true);
    expect(server.calls[0].headers.Accept).toBe('text/event-stream');
  });

  it('reassembles frames delivered across arbitrary chunk boundaries', async () => {
    const full = deltaFrame({ content: 'alpha' }) + deltaFrame({ content: 'beta' }, 'stop') + DONE_FRAME;
    const third = Math.floor(full.length / 3);
    server = installMockServer();
    server.enqueue('/v1/chat/completions', sseResponse([
      full.slice(0, third), full.slice(third, third * 2), full.slice(third * 2),
    ]));
    const { content } = await collectStream(chatStream(config, { messages: [] }));
    expect(content).toBe('alphabeta');
  });

  it('separates reasoning deltas from content deltas', async () => {
    server = installMockServer();
    server.enqueue('/v1/chat/completions', sseResponse([
      deltaFrame({ reasoning_content: 'let me think' }),
      deltaFrame({ content: 'the answer' }, 'stop'),
      DONE_FRAME,
    ]));
    const r = await collectStream(chatStream(config, { messages: [] }));
    expect(r.reasoningContent).toBe('let me think');
    expect(r.content).toBe('the answer');
  });

  it('raises a mid-stream error object rather than truncating silently', async () => {
    server = installMockServer();
    server.enqueue('/v1/chat/completions', sseResponse([
      deltaFrame({ content: 'partial' }),
      `data: ${JSON.stringify({ error: { message: 'engine died' } })}\n\n`,
    ]));
    await expect(drain(chatStream(config, { messages: [] }))).rejects.toThrow('engine died');
  });

  it('flags a stream that ends without a completion marker', async () => {
    // A proxy read timeout looks exactly like a short answer otherwise.
    server = installMockServer();
    server.enqueue('/v1/chat/completions', sseResponse([deltaFrame({ content: 'cut off' })]));
    await expect(drain(chatStream(config, { messages: [] }))).rejects.toThrow(/truncated/);
  });

  it('skips an unparseable frame instead of failing the whole answer', async () => {
    server = installMockServer();
    server.enqueue('/v1/chat/completions', sseResponse([
      deltaFrame({ content: 'a' }),
      'data: {not json\n\n',
      deltaFrame({ content: 'b' }, 'stop'),
      DONE_FRAME,
    ]));
    const { content } = await collectStream(chatStream(config, { messages: [] }));
    expect(content).toBe('ab');
  });

  it('propagates an HTTP error before streaming starts', async () => {
    server = installMockServer();
    server.enqueue('/v1/chat/completions', jsonResponse({ error: { message: 'model not found' } }, 404));
    await expect(drain(chatStream(config, { messages: [] }))).rejects.toMatchObject({
      kind: 'http', status: 404,
    });
  });
});

// ── Cancellation and timeouts ─────────────────────────────────────────────────

describe('chat — cancellation', () => {
  it('reports an already-aborted signal as cancelled, not as a network failure', async () => {
    server = installMockServer();
    const ac = new AbortController();
    ac.abort();
    await expect(chat(config, { messages: [], signal: ac.signal }))
      .rejects.toMatchObject({ kind: 'aborted' });
  });

  it('distinguishes a timeout from a user cancellation', async () => {
    server = installMockServer();
    server.onRequest = () => {
      throw new DOMException('timeout', 'TimeoutError');
    };
    await expect(chat({ ...config, timeoutMs: 1000 }, { messages: [] }))
      .rejects.toMatchObject({ kind: 'timeout' });
  });

  it('aborts an in-flight request when the caller cancels', async () => {
    server = installMockServer();
    const ac = new AbortController();
    server.onRequest = () => { throw new DOMException('aborted', 'AbortError'); };
    setTimeout(() => ac.abort(), 0);
    await expect(chat(config, { messages: [], signal: ac.signal }))
      .rejects.toMatchObject({ kind: 'aborted' });
  });

  it('clears its timeout so a slow-but-successful call is not aborted later', async () => {
    vi.useFakeTimers();
    server = installMockServer();
    server.enqueue('/v1/chat/completions', jsonResponse(completionBody({ content: 'ok' })));
    const result = await chat({ ...config, timeoutMs: 5000 }, { messages: [] });
    expect(result.content).toBe('ok');
    // If the timer were still armed, advancing past it would reject an unhandled promise.
    vi.advanceTimersByTime(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── Tool-call accumulation ────────────────────────────────────────────────────

describe('accumulateToolCalls', () => {
  it('joins argument fragments for one call', () => {
    const events = [
      ...eventsFromChunk(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'getStructLayout', arguments: '{"na' } }] } }] })),
      ...eventsFromChunk(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'me":"ContactMsg"}' } }] } }] })),
    ];
    expect(accumulateToolCalls(events)).toEqual([{
      id: 'c1', type: 'function',
      function: { name: 'getStructLayout', arguments: '{"name":"ContactMsg"}' },
    }]);
  });

  it('keeps two interleaved calls on their own indices', () => {
    // vllm#42696: under load the parser has mis-attributed fragments across
    // indices. Index-keyed accumulation is what makes that detectable.
    const events = [
      ...eventsFromChunk(JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'a', function: { name: 'f', arguments: '{"x":' } },
        { index: 1, id: 'b', function: { name: 'g', arguments: '{"y":' } },
      ] } }] })),
      ...eventsFromChunk(JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 1, function: { arguments: '2}' } },
        { index: 0, function: { arguments: '1}' } },
      ] } }] })),
    ];
    expect(accumulateToolCalls(events)).toEqual([
      { id: 'a', type: 'function', function: { name: 'f', arguments: '{"x":1}' } },
      { id: 'b', type: 'function', function: { name: 'g', arguments: '{"y":2}' } },
    ]);
  });

  it('drops a call that never received a name', () => {
    const events = eventsFromChunk(JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }],
    }));
    expect(accumulateToolCalls(events)).toEqual([]);
  });
});

describe('eventsFromChunk', () => {
  it('treats [DONE] as completion', () => {
    expect(eventsFromChunk('[DONE]')).toEqual([{ type: 'done', finishReason: null }]);
  });

  it('emits nothing for a keep-alive chunk with an empty delta', () => {
    expect(eventsFromChunk(JSON.stringify({ choices: [{ delta: {} }] }))).toEqual([]);
  });

  it('emits nothing for a chunk with no choices', () => {
    expect(eventsFromChunk(JSON.stringify({ id: 'x' }))).toEqual([]);
  });
});
