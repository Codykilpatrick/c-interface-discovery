import { useState, useRef, useEffect } from 'react';
import type { MsgStructPattern } from '../analyzer/types';
import Accordion from './Accordion';

interface MsgStructPatternsProps {
  patterns: MsgStructPattern[];
  onAdd: (pattern: Omit<MsgStructPattern, 'id'>) => void;
  onRemove: (id: string) => void;
  onImport: (patterns: MsgStructPattern[]) => void;
  onExport: () => void;
  onReanalyze: () => void;
  /** Detect structs used across multiple source files and add them in bulk. */
  onDetect?: () => number;
  /** Pre-fill the form with an exact match for this struct name. */
  prefill?: string;
}

const EMPTY_FORM = { name: '', pattern: '' };

export default function MsgStructPatterns({
  patterns,
  onAdd,
  onRemove,
  onImport,
  onExport,
  onReanalyze,
  onDetect,
  prefill,
}: MsgStructPatternsProps) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [regexError, setRegexError] = useState<string | null>(null);
  const [detectMsg, setDetectMsg] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!prefill) return;
    setForm({ name: prefill, pattern: `^${prefill}$` });
    setRegexError(null);
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [prefill]);

  function validateRegex(pattern: string): boolean {
    try {
      new RegExp(pattern);
      setRegexError(null);
      return true;
    } catch (e) {
      setRegexError((e as Error).message);
      return false;
    }
  }

  function handleSubmit() {
    const name = form.name.trim();
    const pattern = form.pattern.trim();
    if (!name || !pattern) return;
    if (!validateRegex(pattern)) return;
    onAdd({ name, pattern });
    setForm(EMPTY_FORM);
    setRegexError(null);
  }

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed: MsgStructPattern[] = JSON.parse(ev.target?.result as string);
        onImport(parsed);
      } catch {
        alert('Invalid pattern file — expected JSON array');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  const canSubmit = form.name.trim().length > 0 && form.pattern.trim().length > 0;

  return (
    <Accordion title="Message Struct Patterns" count={patterns.length} forceOpen={!!prefill}>
      <div className="mt-3 space-y-4">
        <p className="text-xs text-gray-500">
          Match struct names (e.g. <span className="font-mono text-gray-400">_(DATA|PASSBACK)$</span>) to generate graph edges between files that share them.
        </p>

        {/* Toolbar */}
        <div className="flex gap-2 flex-wrap">
          <button
            className="px-3 py-1.5 text-xs bg-blue-800/60 hover:bg-blue-700/60 text-blue-200 rounded transition-colors"
            onClick={onReanalyze}
          >
            ↺ Re-analyze
          </button>
          {onDetect && (
            <button
              className="px-3 py-1.5 text-xs bg-green-900/60 hover:bg-green-800/60 text-green-300 rounded transition-colors"
              onClick={() => {
                const added = onDetect();
                setDetectMsg(added > 0 ? `Added ${added} struct${added !== 1 ? 's' : ''}` : 'No new structs found');
                setTimeout(() => setDetectMsg(null), 3000);
              }}
            >
              ⊕ Detect from files
            </button>
          )}
          {detectMsg && (
            <span className="text-xs text-green-400">{detectMsg}</span>
          )}
          <button
            className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors"
            onClick={onExport}
            disabled={patterns.length === 0}
          >
            ↓ Export JSON
          </button>
          <button
            className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors"
            onClick={() => importRef.current?.click()}
          >
            ↑ Import JSON
          </button>
          <input ref={importRef} type="file" accept=".json" className="hidden" onChange={handleImportFile} />
        </div>

        {/* Pattern list */}
        {patterns.length > 0 && (
          <div className="space-y-1">
            {patterns.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-3 py-2 bg-gray-800/60 rounded text-sm">
                <span className="flex-1 font-mono text-gray-300 truncate">{p.name}</span>
                <span className="font-mono text-xs text-gray-500 truncate max-w-[200px]">{p.pattern}</span>
                <button
                  className="shrink-0 text-xs text-gray-500 hover:text-red-400 transition-colors"
                  onClick={() => onRemove(p.id)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Add form */}
        <div ref={formRef} className="border border-gray-700 rounded-lg p-3 space-y-2">
          <span className="text-xs text-gray-500 font-medium">Add Pattern</span>
          <input
            className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200 placeholder-gray-600"
            placeholder="Label (e.g. Sonar messages)"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          />
          <input
            className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200 font-mono placeholder-gray-600"
            placeholder="Regex (e.g. _(DATA|PASSBACK|HEARTBEAT_MSG)$)"
            value={form.pattern}
            onChange={(e) => {
              setForm((f) => ({ ...f, pattern: e.target.value }));
              if (e.target.value) validateRegex(e.target.value);
            }}
          />
          {regexError && (
            <div className="text-xs text-red-400">{regexError}</div>
          )}
          <button
            className="px-3 py-1.5 text-xs bg-blue-800/70 hover:bg-blue-700/70 text-blue-200 rounded transition-colors disabled:opacity-40"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            Add
          </button>
        </div>
      </div>
    </Accordion>
  );
}
