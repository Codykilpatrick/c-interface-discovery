import { describe, it, expect, afterEach } from 'vitest';
import { formatDiagnostics, runDiagnostics } from '../diagnostics';
import type { ProbeStatus } from '../diagnostics';
import { DEFAULT_LLM_CONFIG, budgetForContext, normalizeConfig, type LlmConfig } from '../config';
import {
  DONE_FRAME, completionBody, deltaFrame, installMockServer,
  jsonResponse, modelsBody, sseResponse,
} from './mockServer';

const config: LlmConfig = {
  ...DEFAULT_LLM_CONFIG,
  enabled: true,
  model: 'google/gemma-4-26B-A4B-it',
};

let server: ReturnType<typeof installMockServer> | null = null;
afterEach(() => {
  server?.restore();
  server = null;
});

/** Wire up a fully working endpoint; individual tests override one response. */
function healthyServer(overrides: Partial<Record<string, () => Response>> = {}) {
  const s = installMockServer();
  let chatCall = 0;
  s.onRequest = (call) => {
    if (call.url.includes('/v1/models')) {
      return (overrides.models ?? (() => jsonResponse(modelsBody([
        { id: 'google/gemma-4-26B-A4B-it', max_model_len: 262144 },
      ]))))();
    }
    const body = call.body as Record<string, unknown>;
    if (body.stream === true) {
      return (overrides.streaming ?? (() => sseResponse([
        deltaFrame({ content: 'one' }), deltaFrame({ content: ' two' }),
        deltaFrame({ content: ' three' }, 'stop'), DONE_FRAME,
      ])))();
    }
    if (body.tools) {
      return (overrides.tools ?? (() => jsonResponse(completionBody({
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_struct_size', arguments: '{"name":"ContactMsg"}' } }],
      }, 'tool_calls'))))();
    }
    if (body.response_format) {
      return (overrides.schema ?? (() => jsonResponse(completionBody({ content: '{"ok":true}' }))))();
    }
    chatCall++;
    return (overrides.completion ?? (() => jsonResponse(completionBody({ content: 'ready' }))))();
  };
  void chatCall;
  return s;
}

const statusOf = (r: Awaited<ReturnType<typeof runDiagnostics>>, id: string): ProbeStatus | undefined =>
  r.results.find((x) => x.id === id)?.status;

describe('runDiagnostics — healthy endpoint', () => {
  it('passes every probe and reports the context length', async () => {
    server = healthyServer();
    const report = await runDiagnostics(config);
    expect(statusOf(report, 'models')).toBe('pass');
    expect(statusOf(report, 'completion')).toBe('pass');
    expect(statusOf(report, 'streaming')).toBe('pass');
    expect(statusOf(report, 'tools')).toBe('pass');
    expect(statusOf(report, 'schema')).toBe('pass');
    expect(report.ok).toBe(true);
    expect(report.maxModelLen).toBe(262144);
  });

  it('suggests a digest budget from the served context length', async () => {
    server = healthyServer();
    const report = await runDiagnostics(config);
    // Capped at the 32k default even though a quarter of 256k is far more.
    expect(report.suggestedDigestBudget).toBe(32_000);
  });

  it('suggests a smaller budget on a short-context deployment', async () => {
    server = healthyServer({
      models: () => jsonResponse(modelsBody([{ id: 'google/gemma-4-26B-A4B-it', max_model_len: 32768 }])),
    });
    const report = await runDiagnostics(config);
    expect(report.suggestedDigestBudget).toBe(8192);
  });

  it('reports progress for each probe as it completes', async () => {
    server = healthyServer();
    const seen: string[] = [];
    await runDiagnostics(config, { onProgress: (r) => seen.push(r.id) });
    expect(seen).toEqual(['models', 'completion', 'reasoning', 'streaming', 'tools', 'schema']);
  });
});

describe('runDiagnostics — unreachable endpoint', () => {
  it('reports one clear failure and skips the rest', async () => {
    server = installMockServer(); // no handler — connection refused
    const report = await runDiagnostics(config);
    expect(statusOf(report, 'models')).toBe('fail');
    for (const id of ['completion', 'streaming', 'tools', 'schema', 'reasoning']) {
      expect(statusOf(report, id)).toBe('skipped');
    }
    expect(report.ok).toBe(false);
  });

  it('points at the nginx proxy when the path 404s', async () => {
    server = installMockServer();
    server.enqueue('/v1/models', jsonResponse({ error: { message: 'not found' } }, 404));
    const report = await runDiagnostics(config);
    expect(report.results[0].remedy).toMatch(/LLM_UPSTREAM|nginx/);
  });

  it('points at the API key on a 401', async () => {
    server = installMockServer();
    server.enqueue('/v1/models', jsonResponse({ error: { message: 'unauthorized' } }, 401));
    const report = await runDiagnostics(config);
    expect(report.results[0].remedy).toMatch(/api-key|API key/i);
  });

  it('never throws, so the panel always has something to render', async () => {
    server = installMockServer();
    server.onRequest = () => { throw new Error('kaboom'); };
    await expect(runDiagnostics(config)).resolves.toBeTruthy();
  });
});

describe('runDiagnostics — capability failures', () => {
  it('warns when the stream arrives as a single lump, meaning a proxy buffered it', async () => {
    server = healthyServer({
      streaming: () => sseResponse([deltaFrame({ content: 'all at once' }, 'stop') + DONE_FRAME]),
    });
    const report = await runDiagnostics(config);
    expect(statusOf(report, 'streaming')).toBe('warn');
    expect(report.results.find((r) => r.id === 'streaming')?.remedy).toMatch(/proxy_buffering/);
  });

  it('fails tool calling when the model answers in prose instead', async () => {
    server = healthyServer({
      tools: () => jsonResponse(completionBody({ content: 'It is 136 bytes.' })),
    });
    const report = await runDiagnostics(config);
    expect(statusOf(report, 'tools')).toBe('fail');
    expect(report.results.find((r) => r.id === 'tools')?.remedy).toMatch(/tool_chat_template_gemma4/);
  });

  it('fails tool calling when arguments come back as unparseable text', async () => {
    // The shape vllm#44522 produces: raw delimiter tokens leaking through.
    server = healthyServer({
      tools: () => jsonResponse(completionBody({
        tool_calls: [{ id: 'c', type: 'function', function: { name: 'get_struct_size', arguments: '<|"|>ContactMsg<|"|>' } }],
      }, 'tool_calls')),
    });
    const report = await runDiagnostics(config);
    expect(statusOf(report, 'tools')).toBe('fail');
    expect(report.results.find((r) => r.id === 'tools')?.detail).toMatch(/not valid JSON/);
  });

  it('fails structured output when response_format is rejected', async () => {
    server = healthyServer({
      schema: () => jsonResponse({ error: { message: 'response_format unsupported' } }, 400),
    });
    const report = await runDiagnostics(config);
    expect(statusOf(report, 'schema')).toBe('fail');
    expect(report.ok).toBe(false);
  });

  it('fails structured output when the reply is not the requested schema', async () => {
    server = healthyServer({ schema: () => jsonResponse(completionBody({ content: 'sure, ok!' })) });
    const report = await runDiagnostics(config);
    expect(statusOf(report, 'schema')).toBe('fail');
  });

  it('only warns about a missing reasoning split, since the app still works', async () => {
    server = healthyServer();
    const report = await runDiagnostics(config);
    expect(statusOf(report, 'reasoning')).toBe('warn');
    expect(report.ok).toBe(true);
  });

  it('passes the reasoning probe when reasoning_content is populated', async () => {
    server = healthyServer({
      completion: () => jsonResponse(completionBody({ content: 'ready', reasoning_content: 'thinking' })),
    });
    const report = await runDiagnostics(config);
    expect(statusOf(report, 'reasoning')).toBe('pass');
  });
});

describe('runDiagnostics — unconfigured', () => {
  it('probes with the discovered model when none has been selected yet', async () => {
    // A first run must tell the operator about the host. Reporting five skips
    // because a dropdown has not been touched yet is useless after a transfer.
    server = healthyServer();
    const report = await runDiagnostics({ ...config, model: '' });
    expect(statusOf(report, 'models')).toBe('pass');
    expect(statusOf(report, 'completion')).toBe('pass');
    expect(statusOf(report, 'tools')).toBe('pass');
    expect(report.ok).toBe(true);
  });

  it('says which model it probed with', async () => {
    server = healthyServer();
    const report = await runDiagnostics({ ...config, model: '' });
    expect(report.results[0].detail).toContain('probing with google/gemma-4-26B-A4B-it');
  });

  it('skips the capability probes when the endpoint serves no models at all', async () => {
    server = healthyServer({ models: () => jsonResponse(modelsBody([])) });
    const report = await runDiagnostics({ ...config, model: '' });
    expect(statusOf(report, 'models')).toBe('pass');
    expect(statusOf(report, 'completion')).toBe('skipped');
    expect(report.ok).toBe(false);
  });

  it('still reports a budget suggestion on the no-models path', async () => {
    // The UI renders a "set budget to N" action from this; an undefined value
    // there produced a button with no number.
    server = healthyServer({ models: () => jsonResponse(modelsBody([])) });
    const report = await runDiagnostics({ ...config, model: '' });
    expect(report.suggestedDigestBudget).toBeUndefined();
    expect(report.maxModelLen).toBeUndefined();
  });
});

describe('formatDiagnostics', () => {
  it('renders a carry-off-the-host text report', async () => {
    server = healthyServer();
    const report = await runDiagnostics(config);
    const text = formatDiagnostics(report, config);
    expect(text).toContain('C Interface Discovery — LLM endpoint diagnostics');
    expect(text).toContain('endpoint: /llm');
    expect(text).toContain('[ PASS ] Tool calling');
    expect(text).toContain('RESULT: usable');
  });

  it('includes the remedy line for a failure', async () => {
    server = installMockServer();
    const report = await runDiagnostics(config);
    const text = formatDiagnostics(report, config);
    expect(text).toContain('[ FAIL ]');
    expect(text).toContain('→ ');
    expect(text).toContain('RESULT: one or more required capabilities failed');
  });
});

describe('config', () => {
  it('derives a quarter-window digest budget, floored and capped', () => {
    expect(budgetForContext(262144)).toBe(32_000);
    expect(budgetForContext(32768)).toBe(8192);
    expect(budgetForContext(4096)).toBe(2000);
    expect(budgetForContext(0)).toBe(DEFAULT_LLM_CONFIG.digestBudgetTokens);
    expect(budgetForContext(Number.NaN)).toBe(DEFAULT_LLM_CONFIG.digestBudgetTokens);
  });

  it('defaults to disabled, so an airgapped build with no endpoint behaves as before', () => {
    expect(DEFAULT_LLM_CONFIG.enabled).toBe(false);
  });

  it('repairs a corrupt stored config rather than producing broken requests', () => {
    const c = normalizeConfig({
      enabled: 'yes', baseUrl: '   ', temperature: 99, maxTokens: -5,
      thinking: 'maybe', timeoutMs: 'soon',
    });
    expect(c.enabled).toBe(false);
    expect(c.baseUrl).toBe('/llm');
    expect(c.temperature).toBe(2);
    expect(c.maxTokens).toBe(1);
    expect(c.thinking).toBe('auto');
    expect(c.timeoutMs).toBe(DEFAULT_LLM_CONFIG.timeoutMs);
  });

  it('strips trailing slashes so URL joining cannot double up', () => {
    expect(normalizeConfig({ baseUrl: 'http://vllm:8000///' }).baseUrl).toBe('http://vllm:8000');
  });

  it('falls back to defaults for a non-object', () => {
    expect(normalizeConfig(null)).toEqual(DEFAULT_LLM_CONFIG);
    expect(normalizeConfig('nonsense')).toEqual(DEFAULT_LLM_CONFIG);
  });
});
