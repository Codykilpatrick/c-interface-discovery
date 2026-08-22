/**
 * The ask loop.
 *
 * Turn shape, and the reason for it:
 *
 *   tool turns   stream: false, tools: [...]        ← reliable
 *   final turn   stream: true,  tool_choice: 'none' ← streaming parser never runs
 *
 * vLLM's `gemma4` tool parser has open streaming defects (vllm#42696, #44522,
 * #39089, #39392) measured at 21–35% success streaming versus 100%
 * non-streaming. Tool turns are a few dozen tokens, so losing streaming there
 * costs nothing perceptually — the UI shows which lookup is running instead,
 * which is better feedback than watching JSON arrive character by character.
 * The long part, the prose answer, still streams.
 */

import { chat, chatStream } from './client';
import type { LlmConfig } from './config';
import { buildDigest, type AnalysisDigest, type DigestScope } from './digest';
import { TOOL_DEFINITIONS, describeCall, executeTool, type ToolContext } from './tools';
import { LlmError, type ChatMessage } from './types';
import type { ApplicationGroup } from '../analyzer/types';

/** Bounded so a confused model cannot loop indefinitely against the GPU. */
export const MAX_TOOL_ROUNDS = 6;
export const MAX_CALLS_PER_ROUND = 10;

export interface ToolTraceEntry {
  label: string;
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  failed: boolean;
}

export type AskEvent =
  | { type: 'digest'; digest: AnalysisDigest }
  | { type: 'thinking' }
  | { type: 'tool-start'; label: string }
  | { type: 'tool-result'; entry: ToolTraceEntry }
  | { type: 'reasoning'; delta: string }
  | { type: 'content'; delta: string }
  | { type: 'done' }
  | { type: 'error'; message: string; kind: string };

export interface AskOptions {
  question: string;
  apps: ApplicationGroup[];
  scope: DigestScope;
  config: LlmConfig;
  /** Prior turns, for a multi-turn conversation. Digest is not repeated. */
  history?: ChatMessage[];
  signal?: AbortSignal;
}

export function systemPrompt(): string {
  return [
    'You are a C interface analysis assistant embedded in a static analysis tool for legacy',
    'submarine combat system codebases. You answer questions about the analyzer\'s output.',
    '',
    'Rules:',
    '1. Ground every factual claim in the analysis context or a tool result. If neither has the',
    '   answer, say so and name what would be needed. Never guess a struct name, byte offset,',
    '   message direction or wire size.',
    '2. Never compute alignment or offsets yourself. Call getStructLayout — it returns real',
    '   offsets, located padding gaps and both target sizes. Arithmetic in prose is wrong.',
    '3. Cite provenance inline as `file.c:142` or `struct ContactMsg` so the analyst can click',
    '   through to it.',
    '4. The context is a summary. When it says entries were withheld, use the named tool rather',
    '   than concluding something does not exist.',
    '5. Prefer a short, direct answer. This is a reference tool, not prose. Use a table when',
    '   comparing several messages or structs.',
    '6. Flag wire-format hazards when they are relevant: a size that differs between 32-bit and',
    '   64-bit targets, a pointer member, a macro-length array, or an estimated layout.',
  ].join('\n');
}

/**
 * Run one question to completion, yielding events for the UI.
 *
 * Never throws: an error is an `error` event, because a chat panel that
 * disappears on a bad response is worse than one that explains itself.
 */
export async function* ask(opts: AskOptions): AsyncGenerator<AskEvent> {
  const { question, apps, scope, config, signal } = opts;

  const digest = buildDigest(apps, {
    budgetTokens: config.digestBudgetTokens,
    scope,
  });
  yield { type: 'digest', digest };

  const ctx: ToolContext = {
    apps,
    defaultAppId: scope.kind === 'all' ? null : scope.appId,
    includeSourceSnippets: config.includeSourceSnippets,
  };

  const messages: ChatMessage[] = [
    { role: 'system', content: `${systemPrompt()}\n\n---\n\n${digest.text}` },
    ...(opts.history ?? []),
    { role: 'user', content: question },
  ];

  try {
    // ── Tool rounds: non-streaming ──────────────────────────────────────────
    let rounds = 0;
    for (; rounds < MAX_TOOL_ROUNDS; rounds++) {
      yield { type: 'thinking' };
      const result = await chat(config, {
        messages,
        tools: TOOL_DEFINITIONS,
        toolChoice: 'auto',
        signal,
      });

      if (result.toolCalls.length === 0) {
        // The model answered without needing a lookup. Push what it said into
        // history so the final streaming turn continues rather than restarts.
        if (result.content.trim() !== '') {
          if (result.reasoningContent) yield { type: 'reasoning', delta: result.reasoningContent };
          yield { type: 'content', delta: result.content };
          yield { type: 'done' };
          return;
        }
        break;
      }

      const calls = result.toolCalls.slice(0, MAX_CALLS_PER_ROUND);
      messages.push({
        role: 'assistant',
        content: result.content || null,
        tool_calls: calls,
      });

      for (const call of calls) {
        const label = (() => {
          try {
            return describeCall(call.function.name, JSON.parse(call.function.arguments || '{}'));
          } catch {
            return `${call.function.name}(?)`;
          }
        })();
        yield { type: 'tool-start', label };

        const exec = executeTool(call.function.name, call.function.arguments, ctx);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: exec.name,
          content: JSON.stringify(exec.result),
        });
        yield {
          type: 'tool-result',
          entry: { label, name: exec.name, args: exec.args, result: exec.result, failed: exec.failed },
        };
      }
    }

    if (rounds >= MAX_TOOL_ROUNDS) {
      // Tell the model to stop looking things up rather than silently cutting it off.
      messages.push({
        role: 'user',
        content: 'Answer now from what you have retrieved. Do not request more lookups.',
      });
    }

    // ── Final turn: streaming, tools disabled ───────────────────────────────
    let sawContent = false;
    for await (const ev of chatStream(config, {
      messages,
      toolChoice: 'none',
      signal,
    })) {
      if (ev.type === 'content') {
        sawContent = true;
        yield { type: 'content', delta: ev.delta };
      } else if (ev.type === 'reasoning') {
        yield { type: 'reasoning', delta: ev.delta };
      }
    }
    if (!sawContent) {
      yield {
        type: 'error',
        kind: 'protocol',
        message: 'The model returned no answer text. It may have exhausted max_tokens on reasoning — try setting Thinking to off.',
      };
      return;
    }
    yield { type: 'done' };
  } catch (e) {
    if (e instanceof LlmError) {
      if (e.kind === 'aborted') {
        yield { type: 'done' };
        return;
      }
      yield { type: 'error', kind: e.kind, message: e.message };
      return;
    }
    yield { type: 'error', kind: 'unknown', message: (e as Error)?.message ?? String(e) };
  }
}

/** Questions worth offering, derived from what the analysis actually found. */
export function suggestedQuestions(apps: ApplicationGroup[], scope: DigestScope): string[] {
  const analyzed = apps.filter((a) => a.analysis !== null);
  const inScope = scope.kind === 'all' ? analyzed : analyzed.filter((a) => a.id === scope.appId);
  if (inScope.length === 0) return [];

  const out: string[] = [];
  const comps = inScope.flatMap((a) => a.analysis!.messageCompositions ?? []);
  const differing = comps.filter((c) => c.differsAcrossTargets);
  const unresolved = inScope.flatMap((a) =>
    a.analysis!.messageInterfaces.filter((m) => !m.structResolved));
  const unknownDir = inScope.flatMap((a) =>
    a.analysis!.messageInterfaces.filter((m) => m.direction === 'unknown' || !m.directionConfident));
  const candidates = inScope.flatMap((a) =>
    (a.analysis!.structRoles?.roles ?? []).filter((r) => r.role === 'root-candidate'));
  const unknownCalls = inScope.flatMap((a) => a.analysis!.files.flatMap((f) => f.unknownCalls));

  out.push('What are my top-level message structures?');
  if (differing.length > 0) {
    out.push(`Why do ${differing.length} messages change size between 32-bit and 64-bit?`);
  }
  if (unresolved.length > 0) {
    out.push(`Why couldn't the struct be resolved for ${unresolved.length} message${unresolved.length > 1 ? 's' : ''}?`);
  }
  if (unknownDir.length > 0) {
    out.push(`Which message directions are uncertain, and what would settle them?`);
  }
  if (candidates.length > 0) {
    out.push(`Are any of the root candidates actually undetected messages?`);
  }
  if (unknownCalls.length > 0) {
    out.push('Which unmatched calls look like messaging wrappers?');
  }
  if (analyzed.length > 1) {
    out.push('Which messages cross an application boundary?');
  }
  return out.slice(0, 6);
}
