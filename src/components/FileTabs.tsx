import type { FileAnalysis } from '../analyzer/types';

interface FileTabsProps {
  files: FileAnalysis[];
  activeFile: string | null;
  onSelect: (filename: string) => void;
}

export default function FileTabs({ files, activeFile, onSelect }: FileTabsProps) {
  if (files.length === 0) return null;

  return (
    <div className="flex gap-1 border-b border-gray-800 mb-4 overflow-x-auto">
      {files.map((f) => {
        const isActive = f.filename === activeFile;
        const riskCount = f.risks.length;
        return (
          <button
            key={f.filename}
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
      })}
    </div>
  );
}
