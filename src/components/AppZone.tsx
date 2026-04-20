import { useRef, useState } from 'react';
import type { ApplicationGroup } from '../analyzer/types';
import DropZone from './DropZone';

interface AppZoneProps {
  group: ApplicationGroup;
  onFiles: (files: File[]) => void;
  onRemoveFile: (filename: string) => void;
  onClearApp: () => void;
  onRename: (name: string) => void;
  onRemoveApp: () => void;
  canRemoveApp: boolean;
  analyzing: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function AppZone({
  group,
  onFiles,
  onRemoveFile,
  onClearApp,
  onRename,
  onRemoveApp,
  canRemoveApp,
  analyzing,
}: AppZoneProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(group.name);
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setEditValue(group.name);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }

  function commitEdit() {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== group.name) onRename(trimmed);
    setEditing(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') commitEdit();
    if (e.key === 'Escape') setEditing(false);
  }

  const sourceFiles = group.files.filter((f) => /\.(c|cpp)$/i.test(f.filename));
  const headerFiles = group.files.filter((f) => /\.h$/i.test(f.filename));

  return (
    <div className="flex flex-col border border-gray-700 rounded-lg bg-gray-900/40 min-w-0">
      {/* Title bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-700/60">
        {editing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-gray-800 border border-blue-600 rounded px-2 py-0.5 text-sm text-gray-100 outline-none min-w-0"
            autoFocus
          />
        ) : (
          <button
            className="flex-1 text-left text-sm font-semibold text-gray-200 truncate hover:text-white transition-colors group"
            onClick={startEdit}
            title="Click to rename"
          >
            {group.name}
            <span className="ml-1.5 text-gray-600 group-hover:text-gray-400 text-xs">✎</span>
          </button>
        )}

        {group.files.length > 0 && (
          <button
            className="text-xs text-gray-600 hover:text-red-400 transition-colors shrink-0"
            onClick={onClearApp}
            title="Remove all files from this application"
          >
            Clear
          </button>
        )}

        {canRemoveApp && (
          <button
            className="text-gray-600 hover:text-red-400 transition-colors shrink-0 text-sm leading-none"
            onClick={onRemoveApp}
            title="Remove this application"
          >
            ✕
          </button>
        )}
      </div>

      {/* Drop zone */}
      <div className="p-2">
        <DropZone
          zone="string"
          onFiles={onFiles}
          label={analyzing ? 'Analyzing…' : 'SOURCE FILES'}
          accept=".c,.h,.cpp"
          description="Drop .c and .h files"
        />
      </div>

      {/* Stats */}
      {group.files.length > 0 && (
        <div className="flex gap-3 px-3 pb-1 text-xs text-gray-600">
          {sourceFiles.length > 0 && <span>{sourceFiles.length} source{sourceFiles.length !== 1 ? 's' : ''}</span>}
          {headerFiles.length > 0 && <span>{headerFiles.length} header{headerFiles.length !== 1 ? 's' : ''}</span>}
          {group.analysis && (
            <span className="text-gray-700">{group.analysis.messageInterfaces.length} interfaces</span>
          )}
        </div>
      )}

      {/* File list */}
      {group.files.length > 0 && (
        <div className="max-h-36 overflow-y-auto px-2 pb-2 space-y-0.5">
          {group.files.map((file) => (
            <div
              key={file.filename}
              className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono ${
                file.rejected ? 'bg-red-950/30 opacity-50' : 'bg-gray-800/50'
              }`}
              title={file.rejected ? `Rejected: ${file.rejectionReason}` : undefined}
            >
              <span className="flex-1 truncate text-gray-400">{file.filename}</span>
              <span className="shrink-0 text-gray-600">{formatBytes(file.sizeBytes)}</span>
              {file.encoding === 'latin-1' && (
                <span className="shrink-0 text-yellow-500" title="Latin-1">⚠</span>
              )}
              {file.rejected ? (
                <span className="shrink-0 text-red-400">✕</span>
              ) : (
                <button
                  className="shrink-0 text-gray-700 hover:text-red-400 transition-colors"
                  onClick={() => onRemoveFile(file.filename)}
                  aria-label={`Remove ${file.filename}`}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
