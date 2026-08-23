/**
 * Endpoint capability probes.
 *
 * This integration is developed without access to the vLLM host — it is built
 * on one network and verified on another, after a media transfer. So the
 * verification has to travel with the code: each probe exercises one capability
 * the app depends on and reports precisely what worked, what did not, and what
 * to change. Run it once after the transfer and the result is the acceptance
 * test.
 *
 * Probes are ordered cheapest-first and later ones are skipped when a
 * prerequisite fails, so a wrong base URL produces one clear error rather than
 * six confusing ones.
 */

import { chat, chatStream, listModels } from './client';
import { budgetForContext, type LlmConfig } from './config';
import { LlmError, type ModelInfo } from './types';

export type ProbeStatus = 'pass' | 'fail' | 'warn' | 'skipped';

export interface ProbeResult {
  id: string;
  label: string;
  status: ProbeStatus;
  /** One line, shown next to the status. */
  detail: string;
  /** What to do about a failure. Empty when it passed. */
  remedy?: string;
  durationMs: number;
}

export interface DiagnosticsReport {
  results: ProbeResult[];
  /** Models reported by the endpoint, if the probe got that far. */
  models: ModelInfo[];
  /** Served context length for the selected model, when reported. */
  maxModelLen?: number;
  /** Suggested `digestBudgetTokens` given `maxModelLen`. */
  suggestedDigestBudget?: number;
  /** True when every non-optional probe passed. */
  ok: boolean;
}

const TOOL_PROBE = {
  type: 'function' as const,
  function: {
    name: 'get_struct_size',
    description: 'Return the size in bytes of a C struct.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Struct name' } },
      required: ['name'],
    },
  },
};

const SCHEMA_PROBE = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'probe',
    schema: {
      type: 'object',
      properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
      required: ['ok'],
      additionalProperties: false,
    },
  },
};

/** Probes that cannot run until the endpoint answers, in emit order. */
const DEPENDENT_PROBES: [string, string][] = [
  ['completion', 'Non-streaming completion'],
  ['reasoning', 'Reasoning split (reasoning_content)'],
  ['streaming', 'Streaming completion (SSE)'],
  ['tools', 'Tool calling'],
  ['schema', 'Structured output (response_format)'],
];

function describe(e: unknown): { detail: string; remedy: string } {
  if (e instanceof LlmError) {
    switch (e.kind) {
      case 'network':
        return {
          detail: e.message,
          remedy:
            'The browser could not reach the endpoint. If using the nginx proxy, check the ' +
            'container was started with LLM_UPSTREAM set and that the vLLM host is reachable ' +
            'from the app container.',
        };
      case 'timeout':
        return { detail: 'Timed out', remedy: 'Raise the timeout, or check whether the GPU is loaded.' };
      case 'aborted':
        return { detail: 'Cancelled', remedy: '' };
      case 'http':
        if (e.status === 404) {
          return {
            detail: `HTTP 404 — ${e.message}`,
            remedy:
              'The path did not resolve. With the proxy, /llm/ must be present in nginx.conf ' +
              '(it is omitted when LLM_UPSTREAM is unset). Without it, check the base URL ends ' +
              'before /v1.',
          };
        }
        if (e.status === 401 || e.status === 403) {
          return { detail: `HTTP ${e.status}`, remedy: 'vLLM is running with --api-key. Set the API key in settings.' };
        }
        return { detail: `HTTP ${e.status} — ${e.message}`, remedy: e.detail ?? '' };
      case 'protocol':
        return { detail: e.message, remedy: 'The response did not match the OpenAI schema. Check the vLLM version.' };
      case 'config':
        return { detail: e.message, remedy: 'Complete the settings above first.' };
    }
  }
  return { detail: String((e as Error)?.message ?? e), remedy: '' };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; ms: number }> {
  const t0 = Date.now();
  try {
    return { value: await fn(), ms: Date.now() - t0 };
  } catch (error) {
    return { error, ms: Date.now() - t0 };
  }
}

export interface DiagnosticsOptions {
  signal?: AbortSignal;
  /** Called after each probe so the UI can render progress. */
  onProgress?: (result: ProbeResult) => void;
}

/**
 * Run every probe. Never throws — a failure is a result, since the whole point
 * is to report what is broken.
 */
export async function runDiagnostics(
  config: LlmConfig,
  opts: DiagnosticsOptions = {},
): Promise<DiagnosticsReport> {
  const results: ProbeResult[] = [];
  const emit = (r: ProbeResult) => {
    results.push(r);
    opts.onProgress?.(r);
  };
  const skip = (id: string, label: string, why: string) =>
    emit({ id, label, status: 'skipped', detail: why, durationMs: 0 });

  let models: ModelInfo[] = [];
  let maxModelLen: number | undefined;

  // ── 1. Reachability + model list ────────────────────────────────────────────
  const modelsProbe = await timed(() => listModels(config, opts.signal));
  if (modelsProbe.error) {
    const { detail, remedy } = describe(modelsProbe.error);
    emit({ id: 'models', label: 'Endpoint reachable (GET /v1/models)', status: 'fail', detail, remedy, durationMs: modelsProbe.ms });
    for (const [id, label] of DEPENDENT_PROBES) skip(id, label, 'Endpoint unreachable');
    return { results, models, ok: false };
  }

  models = modelsProbe.value ?? [];
  const selected = models.find((m) => m.id === config.model) ?? models[0];
  maxModelLen = selected?.maxModelLen;
  emit({
    id: 'models',
    label: 'Endpoint reachable (GET /v1/models)',
    status: 'pass',
    detail:
      `${models.length} model(s): ${models.map((m) => m.id).join(', ') || '(none)'}` +
      (maxModelLen ? ` · max_model_len ${maxModelLen.toLocaleString()}` : ' · max_model_len not reported') +
      (config.model.trim() === '' ? ` · probing with ${selected?.id ?? '(none)'}` : ''),
    durationMs: modelsProbe.ms,
  });

  const suggestion = maxModelLen !== undefined
    ? { maxModelLen, suggestedDigestBudget: budgetForContext(maxModelLen) }
    : {};

  if (models.length === 0) {
    for (const [id, label] of DEPENDENT_PROBES) skip(id, label, 'Endpoint served no models');
    return { results, models, ...suggestion, ok: false };
  }

  // Probe against a real model even before one has been chosen — otherwise a
  // first run reports five skips and tells the operator nothing about the host.
  const probeConfig: LlmConfig =
    config.model.trim() === '' ? { ...config, model: selected!.id } : config;

  // ── 2. Non-streaming completion ─────────────────────────────────────────────
  const completion = await timed(() =>
    chat(probeConfig, {
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      maxTokens: 24,
      thinking: 'off',
      signal: opts.signal,
    }),
  );
  if (completion.error) {
    const { detail, remedy } = describe(completion.error);
    emit({ id: 'completion', label: 'Non-streaming completion', status: 'fail', detail, remedy, durationMs: completion.ms });
  } else {
    emit({
      id: 'completion',
      label: 'Non-streaming completion',
      status: 'pass',
      detail: `Responded in ${completion.ms} ms: ${JSON.stringify((completion.value?.content ?? '').slice(0, 40))}`,
      durationMs: completion.ms,
    });
  }

  // ── 3. Reasoning split ──────────────────────────────────────────────────────
  // Informational: the app works either way, but without --reasoning-parser the
  // thinking text lands in `content` and shows up inside answers.
  if (completion.error) {
    skip('reasoning', 'Reasoning split (reasoning_content)', 'Completion failed');
  } else {
    const hadReasoning = (completion.value?.reasoningContent ?? '') !== '';
    emit({
      id: 'reasoning',
      label: 'Reasoning split (reasoning_content)',
      status: hadReasoning ? 'pass' : 'warn',
      detail: hadReasoning
        ? 'Thinking returned in reasoning_content'
        : 'No reasoning_content on this reply — expected when thinking is off',
      remedy: hadReasoning
        ? ''
        : 'If reasoning text appears inside answers later, serve with --reasoning-parser gemma4.',
      durationMs: 0,
    });
  }

  // ── 4. Streaming ────────────────────────────────────────────────────────────
  const streaming = await timed(async () => {
    let chunks = 0;
    let text = '';
    for await (const ev of chatStream(probeConfig, {
      messages: [{ role: 'user', content: 'Count: one two three' }],
      maxTokens: 32,
      thinking: 'off',
      toolChoice: 'none',
      signal: opts.signal,
    })) {
      if (ev.type === 'content') {
        chunks++;
        text += ev.delta;
      }
    }
    return { chunks, text };
  });
  if (streaming.error) {
    const { detail, remedy } = describe(streaming.error);
    emit({
      id: 'streaming',
      label: 'Streaming completion (SSE)',
      status: 'fail',
      detail,
      remedy:
        remedy ||
        'If the completion probe passed but this one did not, a proxy is buffering the stream. ' +
        'Set proxy_buffering off in the /llm/ location.',
      durationMs: streaming.ms,
    });
  } else {
    const chunks = streaming.value?.chunks ?? 0;
    // One chunk means the body arrived in a single lump — buffered, not streamed.
    emit({
      id: 'streaming',
      label: 'Streaming completion (SSE)',
      status: chunks > 1 ? 'pass' : 'warn',
      detail: chunks > 1
        ? `${chunks} content deltas received`
        : `Only ${chunks} delta — the response was not incrementally streamed`,
      remedy: chunks > 1 ? '' : 'A proxy is buffering. Set proxy_buffering off in the /llm/ location.',
      durationMs: streaming.ms,
    });
  }

  // ── 5. Tool calling ─────────────────────────────────────────────────────────
  const tools = await timed(() =>
    chat(probeConfig, {
      messages: [
        { role: 'system', content: 'Use the provided tool to answer. Do not answer from memory.' },
        { role: 'user', content: 'How many bytes is the struct named ContactMsg?' },
      ],
      tools: [TOOL_PROBE],
      toolChoice: 'auto',
      maxTokens: 256,
      thinking: 'off',
      signal: opts.signal,
    }),
  );
  if (tools.error) {
    const { detail, remedy } = describe(tools.error);
    emit({
      id: 'tools',
      label: 'Tool calling',
      status: 'fail',
      detail,
      remedy: remedy ||
        'Serve with --enable-auto-tool-choice --tool-call-parser gemma4 and the vendored ' +
        'tool_chat_template_gemma4.jinja chat template.',
      durationMs: tools.ms,
    });
  } else {
    const calls = tools.value?.toolCalls ?? [];
    const named = calls.find((c) => c.function.name === TOOL_PROBE.function.name);
    let argsParse = false;
    if (named) {
      try {
        JSON.parse(named.function.arguments);
        argsParse = true;
      } catch {
        argsParse = false;
      }
    }
    emit({
      id: 'tools',
      label: 'Tool calling',
      status: named && argsParse ? 'pass' : 'fail',
      detail: !named
        ? `Model answered without calling the tool (${calls.length} call(s) returned)`
        : argsParse
          ? `Called ${named.function.name} with ${named.function.arguments}`
          : `Called ${named.function.name} but arguments were not valid JSON: ${named.function.arguments.slice(0, 120)}`,
      remedy: named && argsParse
        ? ''
        : 'Check --tool-call-parser gemma4 and that --chat-template points at ' +
          'examples/tool_chat_template_gemma4.jinja. The stock HuggingFace template does not ' +
          'emit the encoding the parser expects.',
      durationMs: tools.ms,
    });
  }

  // ── 6. Structured output ────────────────────────────────────────────────────
  const schema = await timed(() =>
    chat(probeConfig, {
      messages: [{ role: 'user', content: 'Reply with ok set to true.' }],
      responseFormat: SCHEMA_PROBE,
      maxTokens: 64,
      thinking: 'off',
      signal: opts.signal,
    }),
  );
  if (schema.error) {
    const { detail, remedy } = describe(schema.error);
    emit({
      id: 'schema',
      label: 'Structured output (response_format)',
      status: 'fail',
      detail,
      remedy: remedy ||
        'response_format json_schema was rejected. Older vLLM builds use the removed guided_json ' +
        'field instead; the pattern-suggestion feature needs one of the two.',
      durationMs: schema.ms,
    });
  } else {
    let valid = false;
    try {
      const parsed = JSON.parse(schema.value?.content ?? '');
      valid = typeof parsed === 'object' && parsed !== null && 'ok' in parsed;
    } catch {
      valid = false;
    }
    emit({
      id: 'schema',
      label: 'Structured output (response_format)',
      status: valid ? 'pass' : 'fail',
      detail: valid
        ? 'Returned JSON matching the requested schema'
        : `Response did not match the schema: ${(schema.value?.content ?? '').slice(0, 120)}`,
      remedy: valid ? '' : 'Check that the vLLM build has xgrammar-backed structured output enabled.',
      durationMs: schema.ms,
    });
  }

  const ok = results.every((r) => r.status !== 'fail');
  return { results, models, ...suggestion, ok };
}

/** Plain-text report, so a result can be carried back off the airgapped host. */
export function formatDiagnostics(report: DiagnosticsReport, config: LlmConfig): string {
  const mark: Record<ProbeStatus, string> = { pass: '[ PASS ]', fail: '[ FAIL ]', warn: '[ WARN ]', skipped: '[ SKIP ]' };
  const lines = [
    'C Interface Discovery — LLM endpoint diagnostics',
    '='.repeat(60),
    `endpoint: ${config.baseUrl}`,
    `model:    ${config.model || '(none selected)'}`,
    report.maxModelLen ? `context:  ${report.maxModelLen.toLocaleString()} tokens` : 'context:  not reported',
    report.suggestedDigestBudget ? `suggested digest budget: ${report.suggestedDigestBudget.toLocaleString()} tokens` : '',
    '',
  ].filter(Boolean);

  for (const r of report.results) {
    lines.push(`${mark[r.status]} ${r.label}${r.durationMs ? ` (${r.durationMs} ms)` : ''}`);
    if (r.detail) lines.push(`         ${r.detail}`);
    if (r.remedy) lines.push(`         → ${r.remedy}`);
  }
  lines.push('', report.ok ? 'RESULT: usable' : 'RESULT: one or more required capabilities failed');
  return lines.join('\n');
}
