import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_LLM_CONFIG,
  budgetForContext,
  loadLlmConfig,
  saveLlmConfig,
  type LlmConfig,
} from '../llm/config';
import { listModels } from '../llm/client';
import { formatDiagnostics, runDiagnostics, type DiagnosticsReport, type ProbeResult } from '../llm/diagnostics';
import type { ModelInfo } from '../llm/types';
import Accordion from './Accordion';

interface LlmSettingsProps {
  onConfigChange?: (config: LlmConfig) => void;
}

const STATUS_STYLE: Record<ProbeResult['status'], { mark: string; cls: string }> = {
  pass: { mark: '✓', cls: 'text-emerald-400' },
  fail: { mark: '✕', cls: 'text-red-400' },
  warn: { mark: '!', cls: 'text-amber-400' },
  skipped: { mark: '–', cls: 'text-gray-600' },
};

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block mb-3">
      <span className="block text-xs text-gray-400 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-gray-600 mt-1">{hint}</span>}
    </label>
  );
}

const inputCls =
  'w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200 ' +
  'focus:outline-none focus:border-blue-700';

export default function LlmSettings({ onConfigChange }: LlmSettingsProps) {
  const [config, setConfig] = useState<LlmConfig>(() => loadLlmConfig());
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [probeStatus, setProbeStatus] = useState<'idle' | 'running' | 'done'>('idle');
  const [liveResults, setLiveResults] = useState<ProbeResult[]>([]);
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const update = useCallback((patch: Partial<LlmConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      saveLlmConfig(next);
      onConfigChange?.(next);
      return next;
    });
  }, [onConfigChange]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function refreshModels() {
    setConnError(null);
    try {
      const found = await listModels(config);
      setModels(found);
      if (found.length > 0 && config.model === '') {
        const first = found[0];
        update({
          model: first.id,
          ...(first.maxModelLen ? { digestBudgetTokens: budgetForContext(first.maxModelLen) } : {}),
        });
      }
    } catch (e) {
      setModels([]);
      setConnError(e instanceof Error ? e.message : String(e));
    }
  }

  async function runProbes() {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setProbeStatus('running');
    setLiveResults([]);
    setReport(null);
    const result = await runDiagnostics(config, {
      signal: ac.signal,
      onProgress: (r) => setLiveResults((prev) => [...prev, r]),
    });
    setReport(result);
    setModels(result.models);
    setProbeStatus('done');
  }

  function downloadReport() {
    if (!report) return;
    const blob = new Blob([formatDiagnostics(report, config)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cid-llm-diagnostics.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  const shown = report?.results ?? liveResults;

  return (
    <Accordion title="LLM Assistant" count={config.enabled ? undefined : 0}>
      <label className="flex items-center gap-2 mb-4 cursor-pointer">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(e) => update({ enabled: e.target.checked })}
        />
        <span className="text-sm text-gray-300">Enable LLM assistant</span>
        <span className="text-[11px] text-gray-600">
          — off by default; analysis never depends on it
        </span>
      </label>

      {!config.enabled && (
        <p className="text-xs text-gray-600">
          When disabled, nothing here issues a network request and every existing feature behaves
          exactly as it does today.
        </p>
      )}

      {config.enabled && (
        <>
          <div className="grid md:grid-cols-2 gap-x-4">
            <Field
              label="Endpoint"
              hint="Default /llm is the nginx proxy — set LLM_UPSTREAM when starting the container."
            >
              <input
                className={inputCls}
                value={config.baseUrl}
                onChange={(e) => update({ baseUrl: e.target.value })}
                placeholder="/llm"
              />
            </Field>

            <Field label="Model" hint={models.length === 0 ? 'Load models to populate' : `${models.length} available`}>
              <div className="flex gap-2">
                {models.length > 0 ? (
                  <select
                    className={inputCls}
                    value={config.model}
                    onChange={(e) => {
                      const m = models.find((x) => x.id === e.target.value);
                      update({
                        model: e.target.value,
                        ...(m?.maxModelLen ? { digestBudgetTokens: budgetForContext(m.maxModelLen) } : {}),
                      });
                    }}
                  >
                    {models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
                  </select>
                ) : (
                  <input
                    className={inputCls}
                    value={config.model}
                    onChange={(e) => update({ model: e.target.value })}
                    placeholder="google/gemma-4-26B-A4B-it"
                  />
                )}
                <button
                  className="px-2 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded whitespace-nowrap"
                  onClick={refreshModels}
                >
                  Load
                </button>
              </div>
            </Field>

            <Field label="API key" hint="Only if vLLM runs with --api-key. Stored on this workstation only.">
              <input
                type="password"
                className={inputCls}
                value={config.apiKey}
                onChange={(e) => update({ apiKey: e.target.value })}
                placeholder="(none)"
              />
            </Field>

            <Field label="Thinking" hint="Gemma 4 reasoning. Off is faster; auto helps multi-hop questions.">
              <select
                className={inputCls}
                value={config.thinking}
                onChange={(e) => update({ thinking: e.target.value as LlmConfig['thinking'] })}
              >
                <option value="auto">auto</option>
                <option value="off">off</option>
              </select>
            </Field>

            <Field label={`Temperature — ${config.temperature}`} hint="Low: this is an analysis tool.">
              <input
                type="range" min="0" max="1" step="0.1"
                className="w-full"
                value={config.temperature}
                onChange={(e) => update({ temperature: Number(e.target.value) })}
              />
            </Field>

            <Field
              label={`Context budget — ${config.digestBudgetTokens.toLocaleString()} tokens`}
              hint="How much analysis summary goes in the prompt. Tools fetch the rest on demand."
            >
              <input
                type="range" min="2000" max="64000" step="1000"
                className="w-full"
                value={config.digestBudgetTokens}
                onChange={(e) => update({ digestBudgetTokens: Number(e.target.value) })}
              />
            </Field>
          </div>

          <label className="flex items-center gap-2 mb-2 cursor-pointer">
            <input
              type="checkbox"
              checked={config.includeSourceSnippets}
              onChange={(e) => update({ includeSourceSnippets: e.target.checked })}
            />
            <span className="text-xs text-gray-300">Allow the model to fetch source lines</span>
          </label>

          {connError && (
            <div className="mb-3 p-2 border border-red-900/60 bg-red-950/20 rounded text-xs text-red-300">
              {connError}
            </div>
          )}

          {/* ── Diagnostics ─────────────────────────────────────────────── */}
          <div className="border-t border-gray-800 pt-3 mt-2">
            <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
              <div>
                <h4 className="text-sm text-gray-300">Endpoint diagnostics</h4>
                <p className="text-[11px] text-gray-600">
                  Probes each capability the assistant needs and reports what to change.
                  Run this first on a new deployment.
                </p>
              </div>
              <div className="flex gap-2">
                {report && (
                  <button
                    className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded"
                    onClick={downloadReport}
                  >
                    ↓ Save report
                  </button>
                )}
                <button
                  className="px-3 py-1.5 text-xs bg-blue-900/60 hover:bg-blue-800/60 text-blue-200 rounded disabled:opacity-50"
                  onClick={runProbes}
                  disabled={probeStatus === 'running'}
                >
                  {probeStatus === 'running' ? 'Running…' : 'Run diagnostics'}
                </button>
              </div>
            </div>

            {shown.length > 0 && (
              <div className="space-y-1.5">
                {shown.map((r) => {
                  const s = STATUS_STYLE[r.status];
                  return (
                    <div key={r.id} className="text-xs">
                      <div className="flex items-baseline gap-2">
                        <span className={`${s.cls} font-mono w-3 shrink-0`}>{s.mark}</span>
                        <span className="text-gray-300">{r.label}</span>
                        {r.durationMs > 0 && (
                          <span className="text-gray-600">{r.durationMs} ms</span>
                        )}
                      </div>
                      {r.detail && (
                        <div className="pl-5 text-gray-500 break-words">{r.detail}</div>
                      )}
                      {r.remedy && (
                        <div className="pl-5 text-amber-400/80 break-words">→ {r.remedy}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {report && (
              <div
                className={`mt-3 p-2 rounded text-xs border ${
                  report.ok
                    ? 'border-emerald-900/60 bg-emerald-950/20 text-emerald-300'
                    : 'border-red-900/60 bg-red-950/20 text-red-300'
                }`}
              >
                {report.ok
                  ? 'Endpoint usable.'
                  : 'One or more required capabilities failed — see the remedies above.'}
                {report.maxModelLen && (
                  <span className="text-gray-400">
                    {' '}Context {report.maxModelLen.toLocaleString()} tokens
                    {report.suggestedDigestBudget !== undefined &&
                      report.suggestedDigestBudget !== config.digestBudgetTokens && (
                      <>
                        {' · '}
                        <button
                          className="underline hover:text-gray-200"
                          onClick={() => update({ digestBudgetTokens: report.suggestedDigestBudget! })}
                        >
                          set budget to {report.suggestedDigestBudget?.toLocaleString()}
                        </button>
                      </>
                    )}
                  </span>
                )}
              </div>
            )}
          </div>

          <button
            className="mt-3 text-[11px] text-gray-600 hover:text-gray-400 underline"
            onClick={() => {
              const reset = { ...DEFAULT_LLM_CONFIG, enabled: true };
              saveLlmConfig(reset);
              setConfig(reset);
              setReport(null);
              setLiveResults([]);
              onConfigChange?.(reset);
            }}
          >
            Reset to defaults
          </button>
        </>
      )}
    </Accordion>
  );
}
