import { describe, it, expect, afterEach } from 'vitest';
import {
  gatherCandidates, suggestPatterns, verifySuggestion, SUGGESTION_SCHEMA,
} from '../suggest';
import { DEFAULT_LLM_CONFIG, type LlmConfig } from '../config';
import type { CustomPattern, LoadedFile } from '../../analyzer/types';
import { makeApps } from './fixtures/analysisFixture';
import { completionBody, installMockServer, jsonResponse } from './mockServer';

const config: LlmConfig = { ...DEFAULT_LLM_CONFIG, enabled: true, model: 'gemma' };

let server: ReturnType<typeof installMockServer> | null = null;
afterEach(() => { server?.restore(); server = null; });

function src(filename: string, content: string): LoadedFile {
  return {
    filename, content, zone: 'string', encoding: 'utf-8',
    sizeBytes: content.length, oversized: false, rejected: false,
  };
}

const CORPUS = [src('bus.c', [
  'void a(void) { link11_write(fd, PKT_TYPE_LINK_REPORT, &m, sizeof(m)); }',
  'void b(void) { link11_write(fd, PKT_TYPE_STATUS, &s, sizeof(s)); }',
  'void c(void) { plain_helper(1); }',
].join('\n'))];

const good = {
  name: 'link11_write',
  pattern: 'link11_write\\s*\\(',
  ipcType: 'custom',
  direction: 'send',
  msgArgIndex: 1,
  payloadArgIndex: 2,
  lengthArgIndex: 3,
  rationale: 'Takes a message id, a payload pointer and a length.',
};

// ── The gate ──────────────────────────────────────────────────────────────────

describe('verifySuggestion — accepts a real wrapper', () => {
  it('returns the match count and real sample lines', () => {
    const v = verifySuggestion(good, CORPUS, []);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.matchCount).toBe(2);
    expect(v.value.samples[0]).toMatchObject({ filename: 'bus.c', line: 1 });
    expect(v.value.samples[0].text).toContain('link11_write');
  });

  it('maps the proposal onto the real CustomPattern shape', () => {
    const v = verifySuggestion(good, CORPUS, []);
    if (!v.ok) throw new Error('expected accept');
    expect(v.value.pattern).toMatchObject({
      name: 'link11_write', ipcType: 'custom', direction: 'send',
      msgArgIndex: 1, payloadArgIndex: 2, lengthArgIndex: 3,
    });
    expect(v.value.pattern).not.toHaveProperty('id');
  });
});

describe('verifySuggestion — rejects what must never be shown', () => {
  it('rejects an invalid regex rather than throwing', () => {
    const v = verifySuggestion({ ...good, pattern: 'link11_write(' }, CORPUS, []);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.rejected.reason).toContain('Invalid regex');
  });

  it('rejects a pattern that matches nothing in the loaded source', () => {
    const v = verifySuggestion({ ...good, name: 'ghost_send', pattern: 'ghost_send\\s*\\(' }, CORPUS, []);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.rejected.reason).toContain('no lines');
  });

  it('rejects a pattern that matches the empty string', () => {
    // `.*` would reclassify the entire codebase as messaging.
    const v = verifySuggestion({ ...good, pattern: '.*' }, CORPUS, []);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.rejected.reason).toContain('empty string');
  });

  it('rejects a duplicate of an existing registry entry', () => {
    const existing: CustomPattern[] = [{
      id: '1', name: 'link11_write', pattern: 'link11_write\\s*\\(',
      ipcType: 'custom', direction: 'send', notes: '',
    }];
    const v = verifySuggestion(good, CORPUS, existing);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.rejected.reason).toContain('Already in the pattern registry');
  });

  it('rejects a proposal missing a name or pattern', () => {
    expect(verifySuggestion({ pattern: 'x' }, CORPUS, []).ok).toBe(false);
    expect(verifySuggestion({ name: 'x' }, CORPUS, []).ok).toBe(false);
    expect(verifySuggestion({}, CORPUS, []).ok).toBe(false);
    expect(verifySuggestion(null, CORPUS, []).ok).toBe(false);
  });
});

describe('verifySuggestion — warnings on a suspicious but valid pattern', () => {
  it('warns when a pattern matches a large share of all lines', () => {
    const v = verifySuggestion({ ...good, name: 'v', pattern: 'void' }, CORPUS, []);
    if (!v.ok) throw new Error('expected accept with a warning');
    expect(v.value.warnings.join(' ')).toContain('too broad');
  });

  it('warns when the pattern does not mention the call it came from', () => {
    const v = verifySuggestion({ ...good, name: 'link11_write', pattern: 'plain_helper' }, CORPUS, []);
    if (!v.ok) throw new Error('expected accept with a warning');
    expect(v.value.warnings.join(' ')).toContain('does not mention link11_write');
  });
});

describe('verifySuggestion — argument index sanitising', () => {
  it('drops a non-integer or out-of-range index rather than passing it through', () => {
    const v = verifySuggestion(
      { ...good, msgArgIndex: 'one', payloadArgIndex: -1, lengthArgIndex: 99 }, CORPUS, []);
    if (!v.ok) throw new Error('expected accept');
    expect(v.value.pattern).not.toHaveProperty('msgArgIndex');
    expect(v.value.pattern).not.toHaveProperty('payloadArgIndex');
    expect(v.value.pattern).not.toHaveProperty('lengthArgIndex');
  });

  it('falls back to safe defaults for an unknown ipcType or direction', () => {
    const v = verifySuggestion({ ...good, ipcType: 'telepathy', direction: 'sideways' }, CORPUS, []);
    if (!v.ok) throw new Error('expected accept');
    expect(v.value.pattern.ipcType).toBe('custom');
    expect(v.value.pattern.direction).toBe('bidirectional');
  });

  it('drops an invalid msgConstantPattern instead of storing a broken regex', () => {
    const v = verifySuggestion({ ...good, msgConstantPattern: 'MSG_(' }, CORPUS, []);
    if (!v.ok) throw new Error('expected accept');
    expect(v.value.pattern).not.toHaveProperty('msgConstantPattern');
  });

  it('keeps a valid msgConstantPattern', () => {
    const v = verifySuggestion({ ...good, msgConstantPattern: '^PKT_TYPE_' }, CORPUS, []);
    if (!v.ok) throw new Error('expected accept');
    expect(v.value.pattern.msgConstantPattern).toBe('^PKT_TYPE_');
  });
});

// ── Candidates ────────────────────────────────────────────────────────────────

describe('gatherCandidates', () => {
  it('ranks unclassified calls by frequency and attaches real sites', () => {
    const c = gatherCandidates(makeApps(), 'cic');
    expect(c[0].name).toBe('link11_write');
    expect(c[0].sites).toBe(3);
    expect(c[0].samples[0]).toMatch(/track_router\.c:\d+:/);
  });

  it('skips calls with no locatable call site', () => {
    // odd_call appears in unknownCalls and in source, so it survives; a call
    // with no site would be useless to reason about.
    const c = gatherCandidates(makeApps(), 'cic');
    expect(c.every((x) => x.samples.length > 0)).toBe(true);
  });

  it('returns nothing when no application is loaded', () => {
    expect(gatherCandidates([], null)).toEqual([]);
  });
});

// ── End to end ────────────────────────────────────────────────────────────────

function respondWith(suggestions: unknown[]) {
  const s = installMockServer();
  s.enqueue('/v1/chat/completions',
    jsonResponse(completionBody({ content: JSON.stringify({ suggestions }) })));
  return s;
}

describe('suggestPatterns', () => {
  it('sends structured output rather than the removed guided_json field', async () => {
    server = respondWith([]);
    await suggestPatterns({ apps: makeApps(), appId: 'cic', config, existingPatterns: [] });
    expect(server.lastBody().response_format).toEqual(SUGGESTION_SCHEMA);
    expect(server.lastBody()).not.toHaveProperty('guided_json');
  });

  it('disables thinking — extraction does not benefit from it', async () => {
    server = respondWith([]);
    await suggestPatterns({ apps: makeApps(), appId: 'cic', config, existingPatterns: [] });
    expect(server.lastBody().chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('puts the real call sites in the prompt', async () => {
    server = respondWith([]);
    await suggestPatterns({ apps: makeApps(), appId: 'cic', config, existingPatterns: [] });
    const messages = server.lastBody().messages as { role: string; content: string }[];
    expect(messages[1].content).toContain('link11_write');
    expect(messages[1].content).toMatch(/track_router\.c:\d+:/);
  });

  it('returns a verified suggestion with its match count', async () => {
    server = respondWith([{
      name: 'link11_write', pattern: 'link11_write\\s*\\(', ipcType: 'custom',
      direction: 'send', msgArgIndex: 1, rationale: 'takes a packet type and a buffer',
    }]);
    const r = await suggestPatterns({ apps: makeApps(), appId: 'cic', config, existingPatterns: [] });
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0].matchCount).toBe(3);
    expect(r.accepted[0].pattern.msgArgIndex).toBe(1);
  });

  it('drops a hallucinated wrapper that matches nothing', async () => {
    // The failure mode that matters: a plausible-looking pattern for a function
    // that is not actually in the corpus.
    server = respondWith([
      { name: 'imaginary_send', pattern: 'imaginary_send\\s*\\(', ipcType: 'custom', direction: 'send', rationale: 'x' },
      { name: 'link11_write', pattern: 'link11_write\\s*\\(', ipcType: 'custom', direction: 'send', rationale: 'y' },
    ]);
    const r = await suggestPatterns({ apps: makeApps(), appId: 'cic', config, existingPatterns: [] });
    expect(r.accepted.map((a) => a.pattern.name)).toEqual(['link11_write']);
    expect(r.rejected.map((x) => x.name)).toEqual(['imaginary_send']);
  });

  it('records why each rejection happened', async () => {
    server = respondWith([{ name: 'broken', pattern: 'a(', ipcType: 'custom', direction: 'send', rationale: 'x' }]);
    const r = await suggestPatterns({ apps: makeApps(), appId: 'cic', config, existingPatterns: [] });
    expect(r.accepted).toEqual([]);
    expect(r.rejected[0].reason).toContain('Invalid regex');
  });

  it('orders accepted suggestions by strength of evidence', async () => {
    server = respondWith([
      { name: 'odd_call', pattern: 'odd_call\\s*\\(', ipcType: 'custom', direction: 'send', rationale: 'x' },
      { name: 'link11_write', pattern: 'link11_write\\s*\\(', ipcType: 'custom', direction: 'send', rationale: 'y' },
    ]);
    const r = await suggestPatterns({ apps: makeApps(), appId: 'cic', config, existingPatterns: [] });
    expect(r.accepted.map((a) => a.pattern.name)).toEqual(['link11_write', 'odd_call']);
  });

  it('accepts an empty suggestion list without complaint', async () => {
    server = respondWith([]);
    const r = await suggestPatterns({ apps: makeApps(), appId: 'cic', config, existingPatterns: [] });
    expect(r.accepted).toEqual([]);
    expect(r.candidatesConsidered).toContain('link11_write');
  });

  it('raises a clear error when the model returns non-JSON', async () => {
    server = installMockServer();
    server.enqueue('/v1/chat/completions', jsonResponse(completionBody({ content: 'Sure! Here you go:' })));
    await expect(suggestPatterns({ apps: makeApps(), appId: 'cic', config, existingPatterns: [] }))
      .rejects.toThrow(/structured output/);
  });

  it('does not call the model when there is nothing to classify', async () => {
    server = installMockServer();
    const r = await suggestPatterns({ apps: [], appId: null, config, existingPatterns: [] });
    expect(r.accepted).toEqual([]);
    expect(server.calls).toHaveLength(0);
  });

  it('tells the model which patterns are already registered', async () => {
    server = respondWith([]);
    await suggestPatterns({
      apps: makeApps(), appId: 'cic', config,
      existingPatterns: [{ id: '1', name: 'cic_bus_send', pattern: 'x', ipcType: 'custom', direction: 'send', notes: '' }],
    });
    const messages = server.lastBody().messages as { content: string }[];
    expect(messages[1].content).toContain('Already registered');
    expect(messages[1].content).toContain('cic_bus_send');
  });
});
