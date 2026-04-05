import type { CFunction } from '../../analyzer/types';
import Accordion from '../Accordion';

interface FunctionsSectionProps {
  functions: CFunction[];
}

const directionBadge: Record<string, string> = {
  exported: 'bg-blue-900/40 text-blue-400',
  internal: 'bg-gray-700 text-gray-400',
  imported: 'bg-yellow-900/40 text-yellow-400',
};

export default function FunctionsSection({ functions }: FunctionsSectionProps) {
  if (functions.length === 0) return null;

  return (
    <Accordion title="Functions" count={functions.length}>
      <div className="mt-2 space-y-1">
        {functions.map((fn, i) => (
          <div key={i} className="flex items-start gap-3 py-1.5 border-b border-gray-800/60 last:border-0">
            <span className={`shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-xs ${directionBadge[fn.direction]}`}>
              {fn.direction}
            </span>
            <div className="font-mono text-sm min-w-0">
              <span className="text-gray-500">{fn.returnType} </span>
              <span className="text-gray-100">{fn.name}</span>
              <span className="text-gray-600">(</span>
              {fn.params.map((p, j) => (
                <span key={j}>
                  {j > 0 && <span className="text-gray-600">, </span>}
                  <span className="text-gray-500">{p.type} </span>
                  <span className="text-gray-300">{p.name}</span>
                </span>
              ))}
              <span className="text-gray-600">)</span>
            </div>
          </div>
        ))}
      </div>
    </Accordion>
  );
}
