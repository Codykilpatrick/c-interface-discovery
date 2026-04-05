import type { CDefine } from '../../analyzer/types';
import Accordion from '../Accordion';

interface DefinesSectionProps {
  defines: CDefine[];
}

const categoryColor: Record<CDefine['category'], string> = {
  network: 'text-blue-400',
  sizing: 'text-yellow-400',
  flags: 'text-orange-400',
  protocol: 'text-purple-400',
  other: 'text-gray-500',
};

export default function DefinesSection({ defines }: DefinesSectionProps) {
  if (defines.length === 0) return null;

  return (
    <Accordion title="Defines" count={defines.length}>
      <div className="mt-2 space-y-0.5">
        {defines.map((d, i) => (
          <div key={i} className="flex items-center gap-3 py-1 border-b border-gray-800/60 last:border-0 font-mono text-sm">
            <span className={`shrink-0 w-16 text-xs ${categoryColor[d.category]}`}>{d.category}</span>
            <span className="text-gray-300">{d.name}</span>
            <span className="text-gray-500">{d.value}</span>
            {d.conditional && <span className="text-yellow-500 text-xs">⚠ conditional</span>}
          </div>
        ))}
      </div>
    </Accordion>
  );
}
