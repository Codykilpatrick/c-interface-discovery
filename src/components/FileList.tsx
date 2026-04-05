import type { FileRegistryEntry, FileZone } from '../analyzer/types';

interface FileListProps {
  entries: FileRegistryEntry[];
  zone: FileZone;
  onRemove: (filename: string, zone: FileZone) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const roleLabel: Record<string, string> = {
  source: 'source',
  'string-header': 'local-header',
  'external-header': 'ext-header',
};

export default function FileList({ entries, zone, onRemove }: FileListProps) {
  const zoneEntries = entries.filter((e) => e.file.zone === zone);
  if (zoneEntries.length === 0) return null;

  return (
    <div className="mt-2 max-h-48 overflow-y-auto space-y-1 pr-1">
      {zoneEntries.map((entry) => {
        const { file, shadowedBy } = entry;
        const isShadowed = Boolean(shadowedBy);
        const isRejected = file.rejected;

        return (
          <div
            key={`${file.zone}::${file.filename}`}
            className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-mono
              ${isShadowed || isRejected ? 'opacity-40' : ''}
              ${isRejected ? 'bg-red-950/30' : 'bg-gray-800/60'}`}
            title={
              isShadowed
                ? `Shadowed by local version`
                : file.rejectionReason
                  ? `Rejected: ${file.rejectionReason}`
                  : undefined
            }
          >
            <span className="flex-1 truncate text-gray-300">{file.filename}</span>

            {!isRejected && (
              <span className="shrink-0 px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">
                {roleLabel['source']}
              </span>
            )}

            <span className="shrink-0 text-gray-500">{formatBytes(file.sizeBytes)}</span>

            {file.encoding === 'latin-1' && (
              <span className="shrink-0 text-yellow-500" title="Decoded as Latin-1">Latin-1 ⚠</span>
            )}
            {file.encoding === 'utf-8' && !isRejected && (
              <span className="shrink-0 text-gray-600">UTF-8</span>
            )}

            {isRejected && (
              <span className="shrink-0 text-red-400" title={file.rejectionReason}>✕ {file.rejectionReason}</span>
            )}

            {!isShadowed && (
              <button
                className="shrink-0 text-gray-600 hover:text-red-400 transition-colors ml-1"
                onClick={(e) => { e.stopPropagation(); onRemove(file.filename, file.zone); }}
                aria-label={`Remove ${file.filename}`}
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
