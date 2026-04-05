import type { StringAnalysis } from '../analyzer/types';

interface SummaryBarProps {
  analysis: StringAnalysis | null;
}

interface StatProps {
  label: string;
  value: number;
}

function Stat({ label, value }: StatProps) {
  return (
    <div className="flex flex-col items-center px-4 py-2">
      <span className="text-xl font-bold text-gray-100">{value}</span>
      <span className="text-xs text-gray-500 uppercase tracking-wider mt-0.5">{label}</span>
    </div>
  );
}

export default function SummaryBar({ analysis }: SummaryBarProps) {
  if (!analysis) return null;

  const totalFunctions = analysis.files.reduce((s, f) => s + f.functions.length, 0);
  const totalIpc = analysis.files.reduce((s, f) => s + f.ipc.length, 0);
  const totalExterns = analysis.files.reduce((s, f) => s + f.externs.length, 0);
  const totalUnknowns = analysis.files.reduce((s, f) => s + f.unknownCalls.length, 0);
  const totalRisks = analysis.files.reduce((s, f) => s + f.risks.length, 0);

  return (
    <div className="flex items-center divide-x divide-gray-800 border border-gray-800 rounded-lg bg-gray-900/50 mb-6">
      <Stat label="Files" value={analysis.files.length} />
      <Stat label="Functions" value={totalFunctions} />
      <Stat label="Msg Interfaces" value={analysis.messageInterfaces.length} />
      <Stat label="IPC Calls" value={totalIpc} />
      <Stat label="Externs" value={totalExterns} />
      <Stat label="Unknowns" value={totalUnknowns} />
      <Stat label="Risks" value={totalRisks} />
    </div>
  );
}
