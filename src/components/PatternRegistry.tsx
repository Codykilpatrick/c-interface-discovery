import { useState, useRef, useEffect } from 'react';
import type { CustomPattern, IpcType } from '../analyzer/types';
import Accordion from './Accordion';

interface PatternRegistryProps {
  patterns: CustomPattern[];
  onAdd: (pattern: Omit<CustomPattern, 'id'>) => void;
  onUpdate: (id: string, changes: Partial<Omit<CustomPattern, 'id'>>) => void;
  onRemove: (id: string) => void;
  onImport: (patterns: CustomPattern[]) => void;
  onExport: () => void;
  onReanalyze: () => void;
  matchCounts: Map<string, number>;
  /** Pre-fill the form with a function name (e.g. from Unknown Calls). */
  prefill?: string;
}

const IPC_TYPES: IpcType[] = [
  'socket', 'socket-send', 'socket-recv', 'shared-mem', 'pipe', 'fifo',
  'mqueue', 'semaphore', 'signal', 'thread', 'process-fork', 'process-exec',
  'file-io', 'ioctl', 'custom',
];

const EMPTY_FORM: {
  name: string;
  fnName: string;
  pattern: string;
  ipcType: IpcType;
  direction: CustomPattern['direction'];
  notes: string;
} = {
  name: '',
  fnName: '',
  pattern: '',
  ipcType: 'custom',
  direction: 'bidirectional',
  notes: '',
};

/** Escape a string for use in a regex. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Generate a regex that matches a C function call by name. */
function fnNameToRegex(name: string): string {
  return `${escapeRegex(name.trim())}\\s*\\(`;
}

export default function PatternRegistry({
  patterns,
  onAdd,
  onUpdate,
  onRemove,
  onImport,
  onExport,
  onReanalyze,
  matchCounts,
  prefill,
}: PatternRegistryProps) {
  const [mode, setMode] = useState<'simple' | 'advanced'>('simple');
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [regexError, setRegexError] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLDivElement>(null);

  // When a prefill arrives (from Unknown Calls), populate the simple-mode form
  useEffect(() => {
    if (!prefill) return;
    setMode('simple');
    setEditingId(null);
    setForm({ ...EMPTY_FORM, name: prefill, fnName: prefill });
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [prefill]);

  const effectivePattern = mode === 'simple'
    ? fnNameToRegex(form.fnName)
    : form.pattern;

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
    const name = form.name.trim() || form.fnName.trim();
    if (!name) return;
    if (!validateRegex(effectivePattern)) return;

    const payload: Omit<CustomPattern, 'id'> = {
      name,
      pattern: effectivePattern,
      ipcType: form.ipcType,
      direction: form.direction,
      notes: form.notes,
    };

    if (editingId) {
      onUpdate(editingId, payload);
      setEditingId(null);
    } else {
      onAdd(payload);
    }
    setForm(EMPTY_FORM);
  }

  function handleEdit(p: CustomPattern) {
    setEditingId(p.id);
    setMode('advanced');
    setForm({ ...EMPTY_FORM, name: p.name, pattern: p.pattern, ipcType: p.ipcType, direction: p.direction, notes: p.notes });
  }

  function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed: CustomPattern[] = JSON.parse(ev.target?.result as string);
        onImport(parsed);
      } catch {
        alert('Invalid pattern file — expected JSON array');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  const canSubmit = mode === 'simple'
    ? form.fnName.trim().length > 0
    : form.name.trim().length > 0 && form.pattern.trim().length > 0;

  return (
    <Accordion title="Custom Patterns" count={patterns.length} forceOpen={!!prefill}>
      <div className="mt-3 space-y-4">
        {/* Toolbar */}
        <div className="flex gap-2 flex-wrap">
          <button
            className="px-3 py-1.5 text-xs bg-blue-800/60 hover:bg-blue-700/60 text-blue-200 rounded transition-colors"
            onClick={onReanalyze}
          >
            ↺ Re-analyze
          </button>
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
            {patterns.map((p) => {
              const count = matchCounts.get(p.id) ?? 0;
              return (
                <div key={p.id} className="flex items-center gap-3 px-3 py-2 bg-gray-800/60 rounded text-sm">
                  <span className="flex-1 font-mono text-gray-300 truncate">{p.name}</span>
                  <span className="font-mono text-xs text-gray-500 truncate max-w-[160px]">{p.pattern}</span>
                  <span className="shrink-0 text-xs text-gray-600">{p.ipcType}</span>
                  <span className={`shrink-0 text-xs ${count > 0 ? 'text-green-400' : 'text-gray-600'}`}>
                    {count} match{count !== 1 ? 'es' : ''}
                  </span>
                  <button
                    className="shrink-0 text-xs text-gray-500 hover:text-blue-400 transition-colors"
                    onClick={() => handleEdit(p)}
                  >
                    Edit
                  </button>
                  <button
                    className="shrink-0 text-xs text-gray-500 hover:text-red-400 transition-colors"
                    onClick={() => onRemove(p.id)}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Add / Edit form */}
        <div ref={formRef} className="border border-gray-700 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-gray-500 font-medium">
              {editingId ? 'Edit Pattern' : 'Add Pattern'}
            </span>
            {!editingId && (
              <div className="flex text-xs rounded overflow-hidden border border-gray-700">
                <button
                  className={`px-2.5 py-1 transition-colors ${mode === 'simple' ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300'}`}
                  onClick={() => setMode('simple')}
                >
                  Simple
                </button>
                <button
                  className={`px-2.5 py-1 transition-colors ${mode === 'advanced' ? 'bg-gray-700 text-gray-200' : 'text-gray-500 hover:text-gray-300'}`}
                  onClick={() => setMode('advanced')}
                >
                  Regex
                </button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            {mode === 'simple' ? (
              <>
                <input
                  className="col-span-2 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200 font-mono placeholder-gray-600"
                  placeholder="Function name (e.g. torpedo_dispatch)"
                  value={form.fnName}
                  onChange={(e) => setForm((f) => ({ ...f, fnName: e.target.value, name: e.target.value }))}
                  autoFocus={!!prefill}
                />
                {form.fnName.trim() && (
                  <div className="col-span-2 text-xs text-gray-600 font-mono px-1">
                    → <span className="text-gray-400">{fnNameToRegex(form.fnName)}</span>
                  </div>
                )}
              </>
            ) : (
              <>
                <input
                  className="col-span-2 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200 placeholder-gray-600"
                  placeholder="Name (e.g. torpedo_dispatch)"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                />
                <input
                  className="col-span-2 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200 font-mono placeholder-gray-600"
                  placeholder="Regex pattern"
                  value={form.pattern}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, pattern: e.target.value }));
                    if (e.target.value) validateRegex(e.target.value);
                  }}
                />
                {regexError && (
                  <div className="col-span-2 text-xs text-red-400">{regexError}</div>
                )}
              </>
            )}

            <select
              className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-300"
              value={form.ipcType}
              onChange={(e) => setForm((f) => ({ ...f, ipcType: e.target.value as IpcType }))}
            >
              {IPC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select
              className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-300"
              value={form.direction}
              onChange={(e) => setForm((f) => ({ ...f, direction: e.target.value as CustomPattern['direction'] }))}
            >
              <option value="send">send</option>
              <option value="recv">recv</option>
              <option value="bidirectional">bidirectional</option>
            </select>
            <input
              className="col-span-2 bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200 placeholder-gray-600"
              placeholder="Notes (optional)"
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </div>

          <div className="flex gap-2 pt-1">
            <button
              className="px-3 py-1.5 text-xs bg-blue-800/70 hover:bg-blue-700/70 text-blue-200 rounded transition-colors disabled:opacity-40"
              onClick={handleSubmit}
              disabled={!canSubmit}
            >
              {editingId ? 'Save' : 'Add'}
            </button>
            {editingId && (
              <button
                className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors"
                onClick={() => { setEditingId(null); setForm(EMPTY_FORM); }}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>
    </Accordion>
  );
}
