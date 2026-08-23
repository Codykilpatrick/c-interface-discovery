/**
 * vLLM OpenAI-compatible client.
 *
 * Hand-rolled on `fetch` — no SDK, so nothing is added to the airgap transfer.
 *
 * Request strategy is split deliberately (see `conversation.ts`): tool-call
 * turns are non-streaming, the final prose turn streams with
 * `tool_choice: 'none'`.
 */

import type { LlmConfig } from './config';
import { SseParser, readTextChunks } from './sse';
import {
  LlmError,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type ModelInfo,
  type StreamEvent,
  type ToolCall,
} from './types';

export interface ChatOptions {
  messages: ChatMessage[];
  tools?: ChatRequest['tools'];
  toolChoice?: ChatRequest['tool_choice'];
  responseFormat?: ChatRequest['response_format'];
  /** Overrides the configured value for this call. */
  temperature?: number;
  maxTokens?: number;
  thinking?: 'off' | 'auto';
  signal?: AbortSignal;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function authHeaders(config: LlmConfig): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey.trim() !== '') h.Authorization = `Bearer ${config.apiKey.trim()}`;
  return h;
}

/**
 * Combine a caller's signal with a timeout. Returns the signal to use and a
 * cleanup that must run in a `finally` — an uncleared timer keeps the tab awake
 * and can abort a later request that reuses the controller.
 */
function withTimeout(timeoutMs: number, external?: AbortSignal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

function classifyAbort(e: unknown, external?: AbortSignal): LlmError {
  if (external?.aborted) return new LlmError('Request cancelled', 'aborted');
  const name = (e as { name?: string })?.name;
  if (name === 'TimeoutError') return new LlmError('Request timed out', 'timeout');
  if (name === 'AbortError') return new LlmError('Request cancelled', 'aborted');
  return new LlmError(String((e as Error)?.message ?? e), 'network');
}

/** Pull a useful message out of an OpenAI-style error body. */
function extractErrorMessage(bodyText: string, status: number): string {
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === 'string') return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
    if (parsed.message) return parsed.message;
  } catch {
    // Not JSON — nginx and proxies return HTML error pages.
  }
  const trimmed = bodyText.trim().slice(0, 200);
  return trimmed !== '' ? `HTTP ${status}: ${trimmed}` : `HTTP ${status}`;
}

async function throwForStatus(res: Response): Promise<never> {
  const text = await res.text().catch(() => '');
  throw new LlmError(extractErrorMessage(text, res.status), 'http', res.status, text.slice(0, 2000));
}

// ── Models ────────────────────────────────────────────────────────────────────

export async function listModels(config: LlmConfig, signal?: AbortSignal): Promise<ModelInfo[]> {
  const { signal: s, cleanup } = withTimeout(Math.min(config.timeoutMs, 15_000), signal);
  try {
    const res = await fetch(joinUrl(config.baseUrl, 'v1/models'), {
      method: 'GET',
      headers: authHeaders(config),
      signal: s,
    });
    if (!res.ok) await throwForStatus(res);
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) {
      throw new LlmError('Malformed /v1/models response: no data array', 'protocol');
    }
    return body.data.flatMap((raw) => {
      const m = raw as Record<string, unknown>;
      if (typeof m.id !== 'string') return [];
      const len = m.max_model_len;
      return [{
        id: m.id,
        ...(typeof len === 'number' && Number.isFinite(len) ? { maxModelLen: len } : {}),
      }];
    });
  } catch (e) {
    if (e instanceof LlmError) throw e;
    throw classifyAbort(e, signal);
  } finally {
    cleanup();
  }
}

// ── Request assembly ──────────────────────────────────────────────────────────

function buildRequest(config: LlmConfig, opts: ChatOptions, stream: boolean): ChatRequest {
  const thinking = opts.thinking ?? config.thinking;
  const req: ChatRequest = {
    model: config.model,
    messages: opts.messages,
    temperature: opts.temperature ?? config.temperature,
    max_tokens: opts.maxTokens ?? config.maxTokens,
    stream,
  };
  if (opts.tools && opts.tools.length > 0) {
    req.tools = opts.tools;
    req.tool_choice = opts.toolChoice ?? 'auto';
  } else if (opts.toolChoice === 'none') {
    // Explicit 'none' matters on the final turn: it keeps the streaming path
    // away from the tool parser even when the history contains tool calls.
    req.tool_choice = 'none';
  }
  if (opts.responseFormat) req.response_format = opts.responseFormat;
  // Gemma 4's chat template reads this to disable reasoning.
  if (thinking === 'off') req.chat_template_kwargs = { enable_thinking: false };
  return req;
}

function assertConfigured(config: LlmConfig): void {
  if (!config.enabled) throw new LlmError('LLM integration is disabled', 'config');
  if (config.model.trim() === '') throw new LlmError('No model selected', 'config');
}

// ── Non-streaming completion ──────────────────────────────────────────────────

/** Parse a non-streaming `/v1/chat/completions` body. */
export function parseChatResponse(body: unknown): ChatResult {
  const b = body as { choices?: unknown[]; usage?: ChatResult['usage'] };
  const choice = Array.isArray(b.choices) ? (b.choices[0] as Record<string, unknown>) : undefined;
  if (!choice) throw new LlmError('Response contained no choices', 'protocol');

  const message = (choice.message ?? {}) as Record<string, unknown>;
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  const toolCalls: ToolCall[] = rawCalls.flatMap((raw, i) => {
    const c = raw as Record<string, unknown>;
    const fn = (c.function ?? {}) as Record<string, unknown>;
    if (typeof fn.name !== 'string') return [];
    return [{
      id: typeof c.id === 'string' && c.id !== '' ? c.id : `call_${i}`,
      type: 'function' as const,
      function: {
        name: fn.name,
        arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      },
    }];
  });

  return {
    content: typeof message.content === 'string' ? message.content : '',
    reasoningContent: typeof message.reasoning_content === 'string' ? message.reasoning_content : '',
    toolCalls,
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    ...(b.usage ? { usage: b.usage } : {}),
  };
}

export async function chat(config: LlmConfig, opts: ChatOptions): Promise<ChatResult> {
  assertConfigured(config);
  const { signal, cleanup } = withTimeout(config.timeoutMs, opts.signal);
  try {
    const res = await fetch(joinUrl(config.baseUrl, 'v1/chat/completions'), {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify(buildRequest(config, opts, false)),
      signal,
    });
    if (!res.ok) await throwForStatus(res);
    return parseChatResponse(await res.json());
  } catch (e) {
    if (e instanceof LlmError) throw e;
    throw classifyAbort(e, opts.signal);
  } finally {
    cleanup();
  }
}

// ── Streaming completion ──────────────────────────────────────────────────────

/** Translate one SSE payload into stream events. Exported for testing. */
export function eventsFromChunk(payload: string): StreamEvent[] {
  if (payload === '[DONE]') return [{ type: 'done', finishReason: null }];

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    // A malformed frame mid-stream is not worth killing the answer over.
    return [];
  }

  // vLLM can emit an error object mid-stream instead of a chunk.
  if (parsed.error) {
    const err = parsed.error as { message?: string };
    throw new LlmError(err.message ?? 'Stream error', 'protocol');
  }

  const choice = Array.isArray(parsed.choices)
    ? (parsed.choices[0] as Record<string, unknown> | undefined)
    : undefined;
  if (!choice) return [];

  const out: StreamEvent[] = [];
  const delta = (choice.delta ?? {}) as Record<string, unknown>;

  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
    out.push({ type: 'reasoning', delta: delta.reasoning_content });
  }
  if (typeof delta.content === 'string' && delta.content !== '') {
    out.push({ type: 'content', delta: delta.content });
  }
  if (Array.isArray(delta.tool_calls)) {
    delta.tool_calls.forEach((raw, i) => {
      const c = raw as Record<string, unknown>;
      const fn = (c.function ?? {}) as Record<string, unknown>;
      out.push({
        type: 'tool-call-delta',
        index: typeof c.index === 'number' ? c.index : i,
        ...(typeof c.id === 'string' ? { id: c.id } : {}),
        ...(typeof fn.name === 'string' ? { name: fn.name } : {}),
        ...(typeof fn.arguments === 'string' ? { argsDelta: fn.arguments } : {}),
      });
    });
  }
  if (typeof choice.finish_reason === 'string') {
    out.push({ type: 'done', finishReason: choice.finish_reason });
  }
  return out;
}

/**
 * Stream a completion, yielding events as they arrive.
 *
 * Callers that need tool calls should use `chat()` instead — see the note at the
 * top of this file.
 */
export async function* chatStream(
  config: LlmConfig,
  opts: ChatOptions,
): AsyncGenerator<StreamEvent> {
  assertConfigured(config);
  const { signal, cleanup } = withTimeout(config.timeoutMs, opts.signal);
  try {
    const res = await fetch(joinUrl(config.baseUrl, 'v1/chat/completions'), {
      method: 'POST',
      headers: { ...authHeaders(config), Accept: 'text/event-stream' },
      body: JSON.stringify(buildRequest(config, opts, true)),
      signal,
    });
    if (!res.ok) await throwForStatus(res);
    if (!res.body) throw new LlmError('Streaming response had no body', 'protocol');

    const parser = new SseParser();
    let sawDone = false;

    for await (const text of readTextChunks(res.body, signal)) {
      for (const payload of parser.push(text)) {
        for (const ev of eventsFromChunk(payload)) {
          if (ev.type === 'done') sawDone = true;
          yield ev;
        }
      }
    }
    for (const payload of parser.flush()) {
      for (const ev of eventsFromChunk(payload)) {
        if (ev.type === 'done') sawDone = true;
        yield ev;
      }
    }
    // A stream that ends without [DONE] or a finish_reason was truncated —
    // usually a proxy timeout. Say so rather than presenting a partial answer
    // as complete.
    if (!sawDone) {
      throw new LlmError(
        'Stream ended without a completion marker — the response may be truncated',
        'protocol',
      );
    }
  } catch (e) {
    if (e instanceof LlmError) throw e;
    throw classifyAbort(e, opts.signal);
  } finally {
    cleanup();
  }
}
