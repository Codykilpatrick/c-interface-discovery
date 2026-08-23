import { useRef, useState } from 'react';
import type { ApplicationGroup, CustomPattern } from '../analyzer/types';
import { loadLlmConfig } from '../llm/config';
import { LlmError } from '../llm/types';
import {
  gatherCandidates, suggestPatterns,
  type RejectedSuggestion, type VerifiedSuggestion,
} from '../llm/suggest';

interface PatternSuggestionsProps {
  apps: ApplicationGroup[];
  /** Null means every loaded application. */
  appId: string | null;
  existingPatterns: CustomPattern[];
  onAccept: (pattern: Omit<CustomPattern, 'id'>) => void;
  onReanalyze: () => void;
}

export default function PatternSuggestions({
  apps, appId, existingPatterns, onAccept, onReanalyze,
}: PatternSuggestionsProps) {
  const [running, setRunning] = useState(false);
  const [accepted, setAccepted] = useState<VerifiedSuggestion[] | null>(null);
  const [rejected, setRejected] = useState<RejectedSuggestion[]>([]);
  const [considered, setConsidered] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showRejected, setShowRejected] = useState(false);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

  const config = loadLlmConfig();
  const candidateCount = gatherCandidates(apps, appId).length;

  if (!config.enabled) return null;

  async function run() {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true);
    setError(null);
    setAccepted(null);
    setRejected([]);
    setAdded(new Set());
    try {
      const r = await suggestPatterns({
        apps, appId, config, existingPatterns, signal: ac.signal,
      });
      setAccepted(r.accepted);
      setRejected(r.rejected);
      setConsidered(r.candidatesConsidered);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A config error here is the common first-run state; point at the fix
      // rather than leaving a bare "No model selected".
      const isConfig = e instanceof LlmError && e.kind === 'config';
      setError(isConfig ? `${msg} — set one under LLM Assistant, then run the diagnostics.` : msg);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function accept(s: VerifiedSuggestion) {
    onAccept(s.pattern);
    setAdded((prev) => new Set([...prev, s.pattern.name]));
    onReanalyze();
  }

  return (
    <div className="border border-gray-800 rounded-lg mb-2 p-4">
      <div className="flex items-start justify-between gap-3 mb-2 flex-wrap">
        <div>
          <h3 className="text-sm font-medium text-gray-300">Suggest patterns</h3>
          <p className="text-[11px] text-gray-600 mt-0.5 max-w-xl">
            Asks the model which unclassified calls look like messaging wrappers. Every proposal
            is compiled and run against the loaded source before it is shown — anything that
            matches nothing, or is not a valid regex, is discarded.
          </p>
        </div>
        <button
          className="px-3 py-1.5 text-xs bg-blue-900/60 hover:bg-blue-800/60 text-blue-200 rounded disabled:opacity-40 whitespace-nowrap"
          onClick={run}
          disabled={running || candidateCount === 0}
          title={candidateCount === 0 ? 'No unclassified calls to analyse' : undefined}
        >
          {running ? 'Analysing…' : `✦ Suggest from ${candidateCount} call${candidateCount === 1 ? '' : 's'}`}
        </button>
      </div>

      {error && (
        <div className="p-2 border border-red-900/60 bg-red-950/20 rounded text-xs text-red-300">
          {error}
        </div>
      )}

      {accepted?.length === 0 && !error && (
        <p className="text-xs text-gray-500">
          Nothing survived verification
          {considered.length > 0 && <> from {considered.length} candidate(s)</>}.
        </p>
      )}

      {accepted && accepted.length > 0 && (
        <div className="space-y-2 mt-2">
          {accepted.map((s) => {
            const isAdded = added.has(s.pattern.name);
            return (
              <div key={s.pattern.name} className="border border-gray-800 rounded p-2.5 bg-gray-900/40">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-sm text-emerald-300">{s.pattern.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded border border-gray-700 text-gray-400">
                        {s.pattern.ipcType} · {s.pattern.direction}
                      </span>
                      <span className="text-xs text-gray-500">
                        {s.matchCount} match{s.matchCount === 1 ? '' : 'es'}
                      </span>
                    </div>
                    <code className="block font-mono text-[11px] text-blue-300 mt-1 break-all">
                      /{s.pattern.pattern}/
                    </code>
                  </div>
                  <button
                    className={`px-2.5 py-1 text-xs rounded whitespace-nowrap ${
                      isAdded
                        ? 'bg-emerald-950/50 text-emerald-400 cursor-default'
                        : 'bg-gray-800 hover:bg-emerald-900/60 text-gray-300 hover:text-emerald-200'
                    }`}
                    onClick={() => !isAdded && accept(s)}
                    disabled={isAdded}
                  >
                    {isAdded ? '✓ Added' : 'Accept'}
                  </button>
                </div>

                {s.rationale && <p className="text-xs text-gray-500 mt-1.5">{s.rationale}</p>}

                {(s.pattern.msgArgIndex !== undefined ||
                  s.pattern.payloadArgIndex !== undefined ||
                  s.pattern.lengthArgIndex !== undefined) && (
                  <p className="text-[11px] text-gray-600 mt-1 font-mono">
                    {s.pattern.msgArgIndex !== undefined && `msgArg=${s.pattern.msgArgIndex} `}
                    {s.pattern.payloadArgIndex !== undefined && `payloadArg=${s.pattern.payloadArgIndex} `}
                    {s.pattern.lengthArgIndex !== undefined && `lengthArg=${s.pattern.lengthArgIndex}`}
                  </p>
                )}

                {s.warnings.length > 0 && (
                  <div className="mt-1.5 space-y-0.5">
                    {s.warnings.map((w) => (
                      <p key={w} className="text-[11px] text-amber-400/90">⚠ {w}</p>
                    ))}
                  </div>
                )}

                <details className="mt-1.5">
                  <summary className="text-[11px] text-gray-600 cursor-pointer hover:text-gray-400">
                    {s.samples.length} matching line{s.samples.length === 1 ? '' : 's'}
                    {s.matchCount > s.samples.length && ` of ${s.matchCount}`}
                  </summary>
                  <div className="mt-1 space-y-0.5">
                    {s.samples.map((m) => (
                      <div key={`${m.filename}:${m.line}`} className="flex gap-2 font-mono text-[11px]">
                        <span className="text-gray-700 shrink-0">{m.filename}:{m.line}</span>
                        <span className="text-gray-400 truncate">{m.text}</span>
                      </div>
                    ))}
                  </div>
                </details>
              </div>
            );
          })}
        </div>
      )}

      {rejected.length > 0 && (
        <button
          className="mt-2 text-[11px] text-gray-600 hover:text-gray-400 underline"
          onClick={() => setShowRejected((v) => !v)}
        >
          {showRejected ? 'hide' : `${rejected.length} proposal(s) discarded during verification`}
        </button>
      )}

      {showRejected && rejected.length > 0 && (
        <div className="mt-2 pt-2 border-t border-gray-800 space-y-1">
          {rejected.map((r, i) => (
            <div key={`${r.name}-${i}`} className="text-[11px]">
              <span className="font-mono text-gray-500">{r.name}</span>
              <span className="text-gray-600"> — {r.reason}</span>
              {r.pattern && <code className="block font-mono text-gray-700 break-all">/{r.pattern}/</code>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
