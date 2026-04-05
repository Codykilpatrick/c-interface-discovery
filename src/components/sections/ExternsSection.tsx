import type { FileAnalysis } from '../../analyzer/types';
import Accordion from '../Accordion';

interface ExternsSectionProps {
  externs: FileAnalysis['externs'];
}

export default function ExternsSection({ externs }: ExternsSectionProps) {
  if (externs.length === 0) return null;

  return (
    <Accordion title="Extern Declarations" count={externs.length}>
      <div className="mt-2 space-y-1">
        {externs.map((e, i) => (
          <div key={i} className="flex items-center gap-3 py-1 border-b border-gray-800/60 last:border-0 font-mono text-sm">
            <span className={`shrink-0 px-1.5 py-0.5 rounded text-xs ${
              e.kind === 'function' ? 'bg-blue-900/40 text-blue-400' : 'bg-gray-700 text-gray-400'
            }`}>
              {e.kind}
            </span>
            <span className="text-gray-500">{e.dataType}</span>
            <span className="text-gray-300">{e.name}</span>
          </div>
        ))}
      </div>
    </Accordion>
  );
}
