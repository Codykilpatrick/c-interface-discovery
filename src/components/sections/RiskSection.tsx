import type { RiskFlag } from '../../analyzer/types';
import Accordion from '../Accordion';

interface RiskSectionProps {
  risks: RiskFlag[];
}

const severityStyle: Record<string, { icon: string; cls: string }> = {
  high: { icon: '🔴', cls: 'border-red-800/60 bg-red-950/20 text-red-300' },
  medium: { icon: '🟡', cls: 'border-yellow-800/60 bg-yellow-950/20 text-yellow-300' },
  low: { icon: '🔵', cls: 'border-blue-800/60 bg-blue-950/20 text-blue-300' },
};

export default function RiskSection({ risks }: RiskSectionProps) {
  if (risks.length === 0) return null;

  const sorted = [...risks].sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    return order[a.severity] - order[b.severity];
  });

  return (
    <Accordion title="Risk Flags" count={risks.length} defaultOpen={risks.some((r) => r.severity === 'high')}>
      <div className="mt-2 space-y-1.5">
        {sorted.map((r, i) => {
          const style = severityStyle[r.severity] ?? severityStyle.low;
          return (
            <div key={i} className={`flex items-start gap-2 px-3 py-2 rounded border text-sm ${style.cls}`}>
              <span>{style.icon}</span>
              <span>{r.msg}</span>
            </div>
          );
        })}
      </div>
    </Accordion>
  );
}
