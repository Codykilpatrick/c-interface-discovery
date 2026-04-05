import type { CStruct } from '../../analyzer/types';
import Accordion from '../Accordion';

interface StructsSectionProps {
  structs: CStruct[];
}

export default function StructsSection({ structs }: StructsSectionProps) {
  if (structs.length === 0) return null;

  return (
    <Accordion title="Structs" count={structs.length}>
      <div className="mt-2 space-y-3">
        {structs.map((s) => (
          <div key={s.name} className="font-mono text-sm bg-gray-950/50 rounded p-3">
            <div className="text-gray-400 mb-1">
              struct <span className="text-cyan-400">{s.name}</span> {'{'}
              {s.conditional && (
                <span className="ml-2 text-xs text-yellow-500">⚠ conditional</span>
              )}
            </div>
            {s.fields.map((f, i) => (
              <div key={i} className="pl-4 text-gray-300">
                <span className="text-gray-500">{f.type.padEnd(20)}</span> {f.name};
              </div>
            ))}
            <div className="text-gray-400">{'}'}</div>
            <div className="text-gray-600 text-xs mt-1">from: {s.sourceFile}</div>
            {s.conflictsWith && s.conflictsWith.length > 0 && (
              <div className="text-yellow-500 text-xs mt-0.5">
                ⚠ Conflicts with: {s.conflictsWith.join(', ')}
              </div>
            )}
          </div>
        ))}
      </div>
    </Accordion>
  );
}
