import { useState, useRef, useEffect } from 'react';
import type { FileAnalysis } from '../analyzer/types';

interface FileTabsProps {
  files: FileAnalysis[];
  activeFile: string | null;
  onSelect: (filename: string) => void;
}

export default function FileTabs({ files, activeFile, onSelect }: FileTabsProps) {
  const [query, setQuery] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLButtonElement>(null);

  if (files.length === 0) return null;

  const q = query.trim().toLowerCase();
  const filtered = q ? files.filter((f) => f.filename.toLowerCase().includes(q)) : files;

  // Scroll active tab into view when it changes
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [activeFile]);

  // Auto-select single match
  useEffect(() => {
    if (q && filtered.length === 1) onSelect(filtered[0].filename);
  // Only trigger when filtered result changes, not on every onSelect reference change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, filtered.length === 1 ? filtered[0]?.filename : null]);

  return (
    <div className="mb-4">
      {/* Search bar */}
      <div className="flex items-center gap-2 mb-2">
        <div className="relative flex-1 max-w-xs">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-600 text-xs select-none pointer-events-none">⌕</span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter files…"
            className="w-full bg-gray-800 border border-gray-700 rounded pl-6 pr-7 py-1 text-xs font-mono text-gray-300 placeholder-gray-600 focus:outline-none focus:border-gray-500"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-400 text-xs"
            >✕</button>
          )}
        </div>
        {q && (
          <span className="text-xs text-gray-600 shrink-0">
            {filtered.length} / {files.length}
          </span>
        )}
      </div>

      {/* Tabs */}
      <div ref={scrollRef} className="flex gap-1 border-b border-gray-800 overflow-x-auto">
        {filtered.length > 0 ? filtered.map((f) => {
          const isActive = f.filename === activeFile;
          const riskCount = f.risks.length;
          return (
            <button
              key={f.filename}
              ref={isActive ? activeTabRef : undefined}
              onClick={() => onSelect(f.filename)}
              className={`shrink-0 px-4 py-2 text-sm border-b-2 transition-colors whitespace-nowrap
                ${isActive
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-300'
                }`}
            >
              {f.filename}
              {riskCount > 0 && (
                <span className="ml-1.5 text-xs text-yellow-500">⚠{riskCount}</span>
              )}
            </button>
          );
        }) : (
          <div className="py-2 px-1 text-xs text-gray-600 italic">No files match "{query}"</div>
        )}
      </div>
    </div>
  );
}
