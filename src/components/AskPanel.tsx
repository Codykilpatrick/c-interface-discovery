import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApplicationGroup } from '../analyzer/types';
import { loadLlmConfig, type LlmConfig } from '../llm/config';
import { ask, suggestedQuestions, type ToolTraceEntry } from '../llm/conversation';
import type { DigestScope, AnalysisDigest } from '../llm/digest';
import type { ChatMessage } from '../llm/types';

export interface AskPanelProps {
  apps: ApplicationGroup[];
  open: boolean;
  onClose: () => void;
  /** Application the panel opens scoped to. */
  initialAppId?: string | null;
  /** Message constant to pre-scope to, when opened from a message card. */
  initialConstant?: string | null;
  /** Click-through from a citation chip. */
  onNavigate?: (target: { appId?: string; filename?: string; line?: number }) => void;
}

interface Turn {
  id: number;
  question: string;
  answer: string;
  reasoning: string;
  trace: ToolTraceEntry[];
  running: boolean;
  error?: { message: string; kind: string };
  digest?: AnalysisDigest;
}

/** `file.c:142` and `struct Foo` become clickable chips. */
const CITATION_RE = /\b([\w./-]+\.[ch])(?::(\d+))?\b|`([^`]+)`/g;

function AnswerText({
  text,
  onNavigate,
}: {
  text: string;
  onNavigate?: AskPanelProps['onNavigate'];
}) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  CITATION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = CITATION_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const [full, file, line, code] = m;
    if (file) {
      parts.push(
        <button
          key={`c${key++}`}
          className="font-mono text-xs px-1 py-0.5 rounded bg-blue-950/50 text-blue-300 hover:bg-blue-900/60"
          onClick={() => onNavigate?.({ filename: file, ...(line && { line: Number(line) }) })}
          title="Open in the file view"
        >
          {full}
        </button>,
      );
    } else {
      parts.push(
        <code key={`k${key++}`} className="font-mono text-xs px-1 rounded bg-gray-800 text-gray-300">
          {code}
        </code>,
      );
    }
    last = m.index + full.length;
  }
  if (last < text.length) parts.push(text.slice(last));

  return <div className="text-sm text-gray-200 whitespace-pre-wrap leading-relaxed">{parts}</div>;
}

function TraceRow({ entry }: { entry: ToolTraceEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-xs">
      <button
        className={`font-mono hover:underline ${entry.failed ? 'text-amber-400' : 'text-gray-500'}`}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? '▾' : '▸'} {entry.failed ? '⚠ ' : '→ '}{entry.label}
      </button>
      {open && (
        <pre className="mt-1 mb-2 p-2 bg-gray-950 border border-gray-800 rounded overflow-x-auto text-[11px] text-gray-400 max-h-64">
          {JSON.stringify(entry.result, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default function AskPanel({
  apps, open, onClose, initialAppId, initialConstant, onNavigate,
}: AskPanelProps) {
  const [config, setConfig] = useState<LlmConfig>(() => loadLlmConfig());
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [scopeKind, setScopeKind] = useState<'app' | 'all' | 'message'>(
    initialConstant ? 'message' : 'app',
  );
  const [appId, setAppId] = useState<string | null>(initialAppId ?? null);
  const [constant, setConstant] = useState<string | null>(initialConstant ?? null);
  const [showContext, setShowContext] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const turnIdRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  function abortInFlight() {
    abortRef.current?.abort();
    abortRef.current = null;
  }

  const analyzed = useMemo(() => apps.filter((a) => a.analysis !== null), [apps]);

  // Re-read config on open: settings live in another panel.
  useEffect(() => {
    if (open) setConfig(loadLlmConfig());
  }, [open]);

  useEffect(() => {
    if (initialAppId !== undefined && initialAppId !== null) setAppId(initialAppId);
  }, [initialAppId]);

  useEffect(() => {
    if (initialConstant) {
      setConstant(initialConstant);
      setScopeKind('message');
    }
  }, [initialConstant]);

  useEffect(() => () => abortInFlight(), []);
  useEffect(() => {
    if (!open) abortInFlight();
  }, [open]);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  const effectiveAppId = appId ?? analyzed[0]?.id ?? null;

  const scope: DigestScope = useMemo(() => {
    if (scopeKind === 'all') return { kind: 'all' };
    if (scopeKind === 'message' && constant && effectiveAppId) {
      return { kind: 'message', appId: effectiveAppId, constant };
    }
    return { kind: 'app', appId: effectiveAppId ?? '' };
  }, [scopeKind, constant, effectiveAppId]);

  const suggestions = useMemo(() => suggestedQuestions(apps, scope), [apps, scope]);

  const constants = useMemo(() => {
    const app = analyzed.find((a) => a.id === effectiveAppId);
    return (app?.analysis?.messageInterfaces ?? []).map((m) => m.msgTypeConstant);
  }, [analyzed, effectiveAppId]);

  const running = turns.some((t) => t.running);

  const send = useCallback(async (text: string) => {
    const q = text.trim();
    if (q === '' || running) return;
    setQuestion('');

    // Prior turns as history, so a follow-up does not restate the digest.
    const history: ChatMessage[] = turns.flatMap((t) =>
      t.error || t.running || !t.answer
        ? []
        : [
            { role: 'user' as const, content: t.question },
            { role: 'assistant' as const, content: t.answer },
          ],
    );

    const id = ++turnIdRef.current;
    setTurns((prev) => [...prev, { id, question: q, answer: '', reasoning: '', trace: [], running: true }]);

    const ac = new AbortController();
    abortRef.current = ac;

    const patch = (fn: (t: Turn) => Turn) =>
      setTurns((prev) => prev.map((t) => (t.id === id ? fn(t) : t)));

    try {
      for await (const ev of ask({ question: q, apps, scope, config, history, signal: ac.signal })) {
        switch (ev.type) {
          case 'digest': patch((t) => ({ ...t, digest: ev.digest })); break;
          case 'tool-result': patch((t) => ({ ...t, trace: [...t.trace, ev.entry] })); break;
          case 'reasoning': patch((t) => ({ ...t, reasoning: t.reasoning + ev.delta })); break;
          case 'content': patch((t) => ({ ...t, answer: t.answer + ev.delta })); break;
          case 'error': patch((t) => ({ ...t, error: { message: ev.message, kind: ev.kind } })); break;
          default: break;
        }
      }
    } finally {
      patch((t) => ({ ...t, running: false }));
      if (abortRef.current === ac) abortRef.current = null;
    }
  }, [apps, config, running, scope, turns]);

  if (!open) return null;

  return (
    <aside className="fixed top-0 right-0 h-full w-full sm:w-[30rem] bg-gray-950 border-l border-gray-800 flex flex-col z-40 shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 shrink-0">
        <h2 className="text-sm font-semibold text-gray-200">Ask</h2>
        <div className="flex items-center gap-2">
          {turns.length > 0 && (
            <button className="text-xs text-gray-600 hover:text-gray-400" onClick={() => { abortInFlight(); setTurns([]); }}>
              Clear
            </button>
          )}
          <button className="text-gray-600 hover:text-gray-300 text-lg leading-none" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>

      {!config.enabled ? (
        <div className="p-4 text-sm text-gray-500">
          The LLM assistant is disabled. Enable it under <strong className="text-gray-400">LLM
          Assistant</strong> on the main screen, then run the endpoint diagnostics.
        </div>
      ) : (
        <>
          {/* Scope */}
          <div className="px-4 py-2 border-b border-gray-800 shrink-0 space-y-2">
            <div className="flex gap-1 text-xs">
              {(['app', 'all', 'message'] as const).map((k) => (
                <button
                  key={k}
                  className={`px-2 py-1 rounded transition-colors ${
                    scopeKind === k ? 'bg-blue-900/60 text-blue-200' : 'bg-gray-900 text-gray-500 hover:text-gray-300'
                  }`}
                  onClick={() => setScopeKind(k)}
                  disabled={k === 'message' && constants.length === 0}
                >
                  {k === 'app' ? 'This application' : k === 'all' ? 'All applications' : 'One message'}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              {scopeKind !== 'all' && (
                <select
                  className="flex-1 bg-gray-900 border border-gray-800 rounded px-2 py-1 text-xs text-gray-300"
                  value={effectiveAppId ?? ''}
                  onChange={(e) => setAppId(e.target.value)}
                >
                  {analyzed.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              )}
              {scopeKind === 'message' && (
                <select
                  className="flex-1 bg-gray-900 border border-gray-800 rounded px-2 py-1 text-xs text-gray-300 font-mono"
                  value={constant ?? ''}
                  onChange={(e) => setConstant(e.target.value)}
                >
                  <option value="">(select)</option>
                  {constants.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              )}
            </div>
          </div>

          {/* Conversation */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-5">
            {turns.length === 0 && (
              <div>
                <p className="text-xs text-gray-600 mb-2">
                  Answers are grounded in the analyzer&apos;s output — offsets and sizes come from
                  the layout engine, not from the model.
                </p>
                {suggestions.map((s) => (
                  <button
                    key={s}
                    className="block w-full text-left text-xs text-gray-400 hover:text-blue-300 py-1.5 px-2 rounded hover:bg-gray-900"
                    onClick={() => send(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

            {turns.map((t) => (
              <div key={t.id} className="space-y-2">
                <div className="text-sm text-blue-300 font-medium">{t.question}</div>

                {t.digest && (
                  <div className="text-[11px] text-gray-600">
                    <button className="hover:text-gray-400" onClick={() => setShowContext((v) => !v)}>
                      {t.digest.estimatedTokens.toLocaleString()} tokens of context
                      {t.digest.omitted.length > 0 && ` · ${t.digest.omitted.length} section(s) partial`}
                      {' · '}{showContext ? 'hide' : 'what was sent?'}
                    </button>
                    {showContext && (
                      <pre className="mt-1 p-2 bg-gray-950 border border-gray-800 rounded overflow-auto max-h-64 text-[10px] text-gray-500 whitespace-pre-wrap">
                        {t.digest.text}
                      </pre>
                    )}
                  </div>
                )}

                {t.trace.length > 0 && (
                  <div className="border-l-2 border-gray-800 pl-2 space-y-0.5">
                    {t.trace.map((e, j) => <TraceRow key={j} entry={e} />)}
                  </div>
                )}

                {t.running && t.answer === '' && !t.error && (
                  <div className="text-xs text-gray-600 animate-pulse">
                    {t.trace.length > 0 ? 'Reading results…' : 'Thinking…'}
                  </div>
                )}

                {t.reasoning !== '' && (
                  <details className="text-[11px] text-gray-600">
                    <summary className="cursor-pointer hover:text-gray-400">reasoning</summary>
                    <div className="mt-1 pl-2 border-l border-gray-800 whitespace-pre-wrap">{t.reasoning}</div>
                  </details>
                )}

                {t.answer !== '' && <AnswerText text={t.answer} onNavigate={onNavigate} />}

                {t.error && (
                  <div className="p-2 border border-red-900/60 bg-red-950/20 rounded text-xs text-red-300">
                    <span className="font-mono text-red-400">[{t.error.kind}]</span> {t.error.message}
                  </div>
                )}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {/* Composer */}
          <div className="px-4 py-3 border-t border-gray-800 shrink-0">
            <div className="flex gap-2">
              <textarea
                className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200 resize-none focus:outline-none focus:border-blue-700"
                rows={2}
                placeholder="Ask about the analysis…"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send(question);
                  }
                }}
              />
              {running ? (
                <button
                  className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-red-900/60 text-gray-300 rounded self-end"
                  onClick={() => abortRef.current?.abort()}
                >
                  Stop
                </button>
              ) : (
                <button
                  className="px-3 py-1.5 text-xs bg-blue-900/60 hover:bg-blue-800/60 text-blue-200 rounded self-end disabled:opacity-40"
                  onClick={() => send(question)}
                  disabled={question.trim() === ''}
                >
                  Ask
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
