/**
 * LLM provider configuration.
 *
 * Persisted per workstation in localStorage, deliberately *not* in the
 * exportable `cid-config.json` — that file is shared between analysts and should
 * not carry an endpoint or an API key.
 */

export type LayoutlessTarget = '32bit' | '64bit';

export interface LlmConfig {
  /** Master switch. When false nothing in `src/llm` issues a request. */
  enabled: boolean;
  /** Base URL. Default is the same-origin nginx proxy. */
  baseUrl: string;
  /** Model id, normally populated from `/v1/models`. */
  model: string;
  /** Only if the site runs vLLM with `--api-key`. */
  apiKey: string;
  /** Analysis, not prose — keep it low. */
  temperature: number;
  /** Response cap. Thinking tokens count against this. */
  maxTokens: number;
  /** Gemma 4 reasoning mode. */
  thinking: 'off' | 'auto';
  /** Digest size cap. Derived from `max_model_len` when that is known. */
  digestBudgetTokens: number;
  /** Allow `getSourceLines` to return verbatim source. */
  includeSourceSnippets: boolean;
  /**
   * Stream tool-call turns.
   *
   * Default false. vLLM's `gemma4` tool parser has open streaming defects
   * (vllm#42696, #44522, #39089, #39392) reported at 21–35% success streaming
   * versus 100% non-streaming. Tool turns are short, so the cost of not
   * streaming them is negligible; the final prose turn still streams with
   * `tool_choice: 'none'`, which never exercises the buggy path.
   *
   * Flip this on once the upstream fixes land.
   */
  streamToolTurns: boolean;
  /** Request timeout in milliseconds. */
  timeoutMs: number;
}

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  enabled: false,
  baseUrl: '/llm',
  model: '',
  apiKey: '',
  temperature: 0.2,
  maxTokens: 4000,
  thinking: 'auto',
  digestBudgetTokens: 32_000,
  includeSourceSnippets: true,
  streamToolTurns: false,
  timeoutMs: 120_000,
};

const STORAGE_KEY = 'cid_llm_config';

/** Quarter of the window, so tool results and a conversation still fit. */
export const DIGEST_BUDGET_FRACTION = 0.25;

/** Derive a digest budget from the served context length. */
export function budgetForContext(maxModelLen: number): number {
  if (!Number.isFinite(maxModelLen) || maxModelLen <= 0) {
    return DEFAULT_LLM_CONFIG.digestBudgetTokens;
  }
  return Math.max(2000, Math.min(
    DEFAULT_LLM_CONFIG.digestBudgetTokens,
    Math.floor(maxModelLen * DIGEST_BUDGET_FRACTION),
  ));
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Coerce arbitrary stored JSON into a valid config. A hand-edited or
 * schema-drifted localStorage entry must never produce a broken request.
 */
export function normalizeConfig(raw: unknown): LlmConfig {
  const d = DEFAULT_LLM_CONFIG;
  if (!raw || typeof raw !== 'object') return { ...d };
  const o = raw as Record<string, unknown>;

  const baseUrl = typeof o.baseUrl === 'string' && o.baseUrl.trim() !== ''
    ? o.baseUrl.trim().replace(/\/+$/, '')
    : d.baseUrl;

  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : d.enabled,
    baseUrl,
    model: typeof o.model === 'string' ? o.model : d.model,
    apiKey: typeof o.apiKey === 'string' ? o.apiKey : d.apiKey,
    temperature: clampNumber(o.temperature, 0, 2, d.temperature),
    maxTokens: clampNumber(o.maxTokens, 1, 32_768, d.maxTokens),
    thinking: o.thinking === 'off' || o.thinking === 'auto' ? o.thinking : d.thinking,
    digestBudgetTokens: clampNumber(o.digestBudgetTokens, 500, 200_000, d.digestBudgetTokens),
    includeSourceSnippets:
      typeof o.includeSourceSnippets === 'boolean' ? o.includeSourceSnippets : d.includeSourceSnippets,
    streamToolTurns: typeof o.streamToolTurns === 'boolean' ? o.streamToolTurns : d.streamToolTurns,
    timeoutMs: clampNumber(o.timeoutMs, 1000, 600_000, d.timeoutMs),
  };
}

export function loadLlmConfig(): LlmConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return normalizeConfig(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_LLM_CONFIG };
  }
}

export function saveLlmConfig(config: LlmConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Storage disabled or full — the session still works, it just will not persist.
  }
}

export function clearLlmConfig(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
