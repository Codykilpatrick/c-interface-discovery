import type { AnalysisWarning } from '../analyzer/types';

interface WarningBannerProps {
  warnings: AnalysisWarning[];
}

const kindIcon: Record<AnalysisWarning['kind'], string> = {
  collision: '⚡',
  conflict: '⚠',
  encoding: '🔤',
  oversized: '📦',
  'circular-include': '🔄',
  'ifdef-variant': '🔀',
};

export default function WarningBanner({ warnings }: WarningBannerProps) {
  if (warnings.length === 0) return null;

  return (
    <div className="mb-4 border border-yellow-800/60 bg-yellow-950/20 rounded-lg px-4 py-3 space-y-1">
      {warnings.map((w, i) => (
        <div key={i} className="flex items-start gap-2 text-xs text-yellow-300">
          <span className="shrink-0">{kindIcon[w.kind]}</span>
          <span>{w.message}</span>
        </div>
      ))}
    </div>
  );
}
