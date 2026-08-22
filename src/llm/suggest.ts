/**
 * Custom pattern suggestion — LLM proposes, the analyzer judges.
 *
 * The tool's first known limitation is that custom messaging wrappers go
 * undetected until an analyst hand-writes a regex for them. Recognising
 * `titan_send_message(handle, MSG_ID, &buf, len)` as a transport wrapper is a
 * good task for a model, *and* — the part that makes this worth building — the
 * output is machine-checkable.
 *
 * So nothing the model proposes is displayed until it has been compiled and run
 * against the loaded corpus. An invalid regex or one that matches nothing is
 * dropped silently; what the analyst sees is a pattern with a real match count
 * and real matching lines. Accepting routes through the normal registry.
 *
 * The model writes a hypothesis. The deterministic analyzer decides whether it
 * survives.
 */

import type { ApplicationGroup, CustomPattern, IpcType, LoadedFile } from '../analyzer/types';
import { chat } from './client';
import type { LlmConfig } from './config';
import { LlmError } from './types';
import type { JsonSchemaFormat } from './types';

/** A proposal that has passed verification. */
export interface VerifiedSuggestion {
  /** Ready to hand to `patternRegistry.add`. */
  pattern: Omit<CustomPattern, 'id'>;
  /** Lines matched across the loaded corpus. */
  matchCount: number;
  /** Up to `MAX_SAMPLES` real matching lines, with provenance. */
  samples: { filename: string; line: number; text: string }[];
  /** Why the model thinks this is a messaging wrapper. */
  rationale: string;
  /** Non-fatal concerns found during verification. */
  warnings: string[];
}

/** A proposal that failed, kept for the "why did nothing appear" case. */
export interface RejectedSuggestion {
  name: string;
  pattern: string;
  reason: string;
}

export interface SuggestionResult {
  accepted: VerifiedSuggestion[];
  rejected: RejectedSuggestion[];
  /** Calls that were offered to the model as candidates. */
  candidatesConsidered: string[];
}

const MAX_SAMPLES = 10;
const MAX_CANDIDATES = 12;
const MAX_SITES_PER_CANDIDATE = 4;

const IPC_TYPES: IpcType[] = [
  'socket', 'socket-send', 'socket-recv', 'shared-mem', 'pipe', 'fifo', 'mqueue',
  'semaphore', 'signal', 'thread', 'process-fork', 'process-exec', 'file-io',
  'ioctl', 'custom',
];

/**
 * Pinned to the real `CustomPattern` shape. Gemma 4 supports structured output
 * natively; `response_format` is used rather than the `guided_*` fields removed
 * in vLLM 0.12.0.
 */
export const SUGGESTION_SCHEMA: JsonSchemaFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'pattern_suggestions',
    schema: {
      type: 'object',
      properties: {
        suggestions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'The wrapper function name' },
              pattern: {
                type: 'string',
                description: 'JavaScript regex matching the call. Escape regex metacharacters.',
              },
              ipcType: { type: 'string', enum: IPC_TYPES },
              direction: { type: 'string', enum: ['send', 'recv', 'bidirectional', 'control'] },
              msgArgIndex: { type: 'integer', description: '0-based index of the message id argument' },
              payloadArgIndex: { type: 'integer', description: '0-based index of the payload pointer' },
              lengthArgIndex: { type: 'integer', description: '0-based index of the length argument' },
              msgConstantPattern: { type: 'string', description: 'Regex for the message constant naming convention' },
              rationale: { type: 'string', description: 'Why this is a messaging wrapper, from the call sites' },
              notes: { type: 'string' },
            },
            required: ['name', 'pattern', 'ipcType', 'direction', 'rationale'],
          },
        },
      },
      required: ['suggestions'],
    },
  },
};

function systemPrompt(): string {
  return [
    'You identify custom messaging wrappers in legacy C code.',
    '',
    'You are given function calls the static analyzer could not classify, with real call',
    'sites. Some are messaging transport wrappers — they send or receive a message over IPC.',
    'Most are not: they are logging, allocation, math, string handling or local helpers.',
    '',
    'For each call that IS a messaging wrapper, produce a pattern entry. Rules:',
    '1. `pattern` is a JavaScript regex that matches the call at its call sites. Escape regex',
    '   metacharacters. Anchor on the function name; keep it simple and specific.',
    '2. Argument indices are 0-based and count the *call* arguments, left to right.',
    '3. Only include an index when the call sites actually show it. Omit it when unsure —',
    '   a wrong index is worse than a missing one.',
    '4. `direction` is send when the caller supplies the payload, recv when it supplies a',
    '   buffer to fill, control for connect/close/register.',
    '5. `rationale` cites what in the call sites made you decide. One sentence.',
    '',
    'Return an empty array if none of the candidates are messaging wrappers. Guessing costs',
    'the analyst more time than saying nothing.',
  ].join('\n');
}

/** Candidate calls with their real sites, ranked by frequency. */
export interface Candidate {
  name: string;
  sites: number;
  samples: string[];
}

export function gatherCandidates(apps: ApplicationGroup[], appId: string | null): Candidate[] {
  const scoped = apps.filter((a) => a.analysis && (appId === null || a.id === appId));
  const counts = new Map<string, { count: number; samples: string[] }>();

  for (const app of scoped) {
    const sources = app.files.filter((f) => /\.(c|cpp)$/i.test(f.filename) && !f.rejected);
    for (const fa of app.analysis!.files) {
      for (const call of fa.unknownCalls) {
        const e = counts.get(call) ?? { count: 0, samples: [] };
        e.count++;
        if (e.samples.length < MAX_SITES_PER_CANDIDATE) {
          const re = new RegExp(`\\b${call.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`);
          for (const f of sources) {
            const lines = f.content.split('\n');
            for (let i = 0; i < lines.length && e.samples.length < MAX_SITES_PER_CANDIDATE; i++) {
              if (re.test(lines[i])) e.samples.push(`${f.filename}:${i + 1}: ${lines[i].trim()}`);
            }
          }
        }
        counts.set(call, e);
      }
    }
  }

  return [...counts.entries()]
    .filter(([, e]) => e.samples.length > 0)
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, MAX_CANDIDATES)
    .map(([name, e]) => ({ name, sites: e.count, samples: e.samples }));
}

// ── Verification ──────────────────────────────────────────────────────────────

function sourceFilesOf(apps: ApplicationGroup[], appId: string | null): LoadedFile[] {
  return apps
    .filter((a) => appId === null || a.id === appId)
    .flatMap((a) => a.files.filter((f) => /\.(c|cpp)$/i.test(f.filename) && !f.rejected));
}

/**
 * Compile the proposed regex and run it against the corpus.
 *
 * This is the gate. Nothing reaches the analyst that has not matched real code.
 */
export function verifySuggestion(
  raw: unknown,
  sources: LoadedFile[],
  existing: CustomPattern[],
): { ok: true; value: VerifiedSuggestion } | { ok: false; rejected: RejectedSuggestion } {
  // The gate must never throw: a malformed proposal is precisely what it is for.
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const name = typeof s.name === 'string' ? s.name.trim() : '';
  const patternStr = typeof s.pattern === 'string' ? s.pattern.trim() : '';

  const reject = (reason: string): { ok: false; rejected: RejectedSuggestion } => ({
    ok: false,
    rejected: { name: name || '(unnamed)', pattern: patternStr, reason },
  });

  if (name === '' || patternStr === '') return reject('Missing name or pattern');

  let re: RegExp;
  try {
    re = new RegExp(patternStr);
  } catch (e) {
    return reject(`Invalid regex: ${(e as Error).message}`);
  }

  // A pattern that matches everything is worse than none — it would reclassify
  // the whole codebase as messaging.
  if (re.test('')) return reject('Pattern matches the empty string');

  if (existing.some((p) => p.pattern === patternStr)) {
    return reject('Already in the pattern registry');
  }

  // Run it. Cap the sample list but count every match.
  const samples: VerifiedSuggestion['samples'] = [];
  let matchCount = 0;
  const matchedFiles = new Set<string>();
  for (const f of sources) {
    const lines = f.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      matchCount++;
      matchedFiles.add(f.filename);
      if (samples.length < MAX_SAMPLES) {
        samples.push({ filename: f.filename, line: i + 1, text: lines[i].trim() });
      }
    }
  }

  if (matchCount === 0) return reject('Matched no lines in the loaded source');

  const warnings: string[] = [];
  // A pattern hitting a large share of all lines is almost certainly too loose.
  const totalLines = sources.reduce((n, f) => n + f.content.split('\n').length, 0);
  if (totalLines > 0 && matchCount / totalLines > 0.1) {
    warnings.push(`Matches ${((matchCount / totalLines) * 100).toFixed(0)}% of all lines — likely too broad`);
  }
  // The proposal should match the call it was derived from.
  if (!new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(patternStr)) {
    warnings.push(`Pattern does not mention ${name}`);
  }

  const idx = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isInteger(n) && n >= 0 && n < 16 ? n : undefined;
  };

  const direction = s.direction;
  const ipcType = s.ipcType;

  const pattern: Omit<CustomPattern, 'id'> = {
    name,
    pattern: patternStr,
    ipcType: IPC_TYPES.includes(ipcType as IpcType) ? (ipcType as IpcType) : 'custom',
    direction:
      direction === 'send' || direction === 'recv' || direction === 'bidirectional' || direction === 'control'
        ? direction
        : 'bidirectional',
    notes: typeof s.notes === 'string' ? s.notes : `Suggested from ${matchedFiles.size} file(s)`,
    ...(idx(s.msgArgIndex) !== undefined && { msgArgIndex: idx(s.msgArgIndex) }),
    ...(idx(s.payloadArgIndex) !== undefined && { payloadArgIndex: idx(s.payloadArgIndex) }),
    ...(idx(s.lengthArgIndex) !== undefined && { lengthArgIndex: idx(s.lengthArgIndex) }),
    ...(typeof s.msgConstantPattern === 'string' && s.msgConstantPattern.trim() !== ''
      && isValidRegex(s.msgConstantPattern)
      && { msgConstantPattern: s.msgConstantPattern.trim() }),
  };

  return {
    ok: true,
    value: {
      pattern,
      matchCount,
      samples,
      rationale: typeof s.rationale === 'string' ? s.rationale : '',
      warnings,
    },
  };
}

function isValidRegex(s: string): boolean {
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
}

// ── Orchestration ─────────────────────────────────────────────────────────────

export interface SuggestOptions {
  apps: ApplicationGroup[];
  appId: string | null;
  config: LlmConfig;
  existingPatterns: CustomPattern[];
  signal?: AbortSignal;
}

/**
 * Ask for pattern suggestions and return only those that survive verification.
 *
 * Throws only on transport failure; a model that proposes nothing usable
 * returns an empty `accepted` list with the reasons in `rejected`.
 */
export async function suggestPatterns(opts: SuggestOptions): Promise<SuggestionResult> {
  const { apps, appId, config, existingPatterns, signal } = opts;

  const candidates = gatherCandidates(apps, appId);
  if (candidates.length === 0) {
    return { accepted: [], rejected: [], candidatesConsidered: [] };
  }

  const known = existingPatterns.map((p) => p.name).join(', ');
  const userPrompt = [
    'Unclassified calls, ranked by frequency, with real call sites:',
    '',
    ...candidates.map((c) => [
      `### ${c.name} — ${c.sites} site(s)`,
      ...c.samples.map((s) => `    ${s}`),
    ].join('\n')),
    '',
    known !== '' ? `Already registered (do not repeat): ${known}` : '',
    '',
    'Which of these are messaging transport wrappers?',
  ].filter(Boolean).join('\n');

  // Structured output, no reasoning: this is an extraction task and thinking
  // only spends max_tokens.
  const result = await chat(config, {
    messages: [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: userPrompt },
    ],
    responseFormat: SUGGESTION_SCHEMA,
    thinking: 'off',
    signal,
  });

  let parsed: { suggestions?: unknown[] };
  try {
    parsed = JSON.parse(result.content) as { suggestions?: unknown[] };
  } catch {
    throw new LlmError(
      'The model did not return valid JSON. Check that structured output is working — ' +
      'run the endpoint diagnostics.',
      'protocol',
    );
  }

  const sources = sourceFilesOf(apps, appId);
  const accepted: VerifiedSuggestion[] = [];
  const rejected: RejectedSuggestion[] = [];

  for (const raw of Array.isArray(parsed.suggestions) ? parsed.suggestions : []) {
    const verdict = verifySuggestion(raw, sources, existingPatterns);
    if (verdict.ok) accepted.push(verdict.value);
    else rejected.push(verdict.rejected);
  }

  // Most matches first: the strongest evidence at the top.
  accepted.sort((a, b) => b.matchCount - a.matchCount || a.pattern.name.localeCompare(b.pattern.name));

  return { accepted, rejected, candidatesConsidered: candidates.map((c) => c.name) };
}
