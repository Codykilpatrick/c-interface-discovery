import type { CFunction, IpcType, StringAnalysis } from '../analyzer/types';
import { useState } from 'react';

interface ExternalInterfacesSummaryProps {
  analysis: StringAnalysis;
}

// ── IPC type → display group ──────────────────────────────────────────────────

const MECHANISM_GROUPS: { label: string; types: IpcType[]; color: string }[] = [
  { label: 'Network',        types: ['socket', 'socket-send', 'socket-recv'],         color: 'text-blue-400' },
  { label: 'Shared Memory',  types: ['shared-mem'],                                   color: 'text-purple-400' },
  { label: 'Pipes & FIFOs',  types: ['pipe', 'fifo'],                                 color: 'text-yellow-400' },
  { label: 'Message Queues', types: ['mqueue'],                                       color: 'text-orange-400' },
  { label: 'Semaphores',     types: ['semaphore'],                                    color: 'text-pink-400' },
  { label: 'Signals',        types: ['signal'],                                       color: 'text-red-400' },
  { label: 'Threads',        types: ['thread'],                                       color: 'text-cyan-400' },
  { label: 'Process',        types: ['process-fork', 'process-exec'],                 color: 'text-green-400' },
  { label: 'File I/O',       types: ['file-io', 'ioctl'],                             color: 'text-gray-400' },
  { label: 'Custom',         types: ['custom'],                                       color: 'text-teal-400' },
];

const FILE_DISPLAY_LIMIT = 3;

interface IpcGroupData {
  label: string;
  color: string;
  callNames: string[];   // deduplicated call function names
  files: string[];       // files that use this mechanism
}

interface ExportedFn {
  fn: CFunction;
  file: string;
}

function callName(detail: string): string {
  // Extract the function name from a call detail string like "socket(AF_INET, ...)"
  return detail.split('(')[0].trim();
}

function buildIpcGroups(analysis: StringAnalysis): IpcGroupData[] {
  const groups: IpcGroupData[] = [];

  for (const group of MECHANISM_GROUPS) {
    const callNamesSet = new Set<string>();
    const filesSet = new Set<string>();

    for (const file of analysis.files) {
      for (const ipc of file.ipc) {
        if (group.types.includes(ipc.type)) {
          callNamesSet.add(callName(ipc.detail));
          filesSet.add(file.filename);
        }
      }
    }

    if (filesSet.size > 0) {
      groups.push({
        label: group.label,
        color: group.color,
        callNames: [...callNamesSet],
        files: [...filesSet],
      });
    }
  }

  return groups;
}

function buildExportedFunctions(analysis: StringAnalysis): ExportedFn[] {
  const result: ExportedFn[] = [];
  for (const file of analysis.files) {
    for (const fn of file.functions) {
      if (fn.direction === 'exported') {
        result.push({ fn, file: file.filename });
      }
    }
  }
  return result;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function FileList({ files }: { files: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? files : files.slice(0, FILE_DISPLAY_LIMIT);
  const hidden = files.length - FILE_DISPLAY_LIMIT;
  return (
    <div className="flex flex-wrap gap-1 mt-1.5">
      {visible.map((f) => (
        <span key={f} className="text-xs font-mono px-1.5 py-0.5 bg-gray-800 rounded text-gray-500">{f}</span>
      ))}
      {!expanded && hidden > 0 && (
        <button
          className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
          onClick={() => setExpanded(true)}
        >
          +{hidden} more
        </button>
      )}
    </div>
  );
}

function IpcGroupRow({ group }: { group: IpcGroupData }) {
  return (
    <div className="py-3 border-b border-gray-800/60 last:border-0">
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className={`text-sm font-semibold w-32 shrink-0 ${group.color}`}>{group.label}</span>
        <span className="text-xs text-gray-600">{group.files.length} file{group.files.length !== 1 ? 's' : ''}</span>
        <span className="font-mono text-xs text-gray-500">
          {group.callNames.join('()  ') + '()'}
        </span>
      </div>
      <FileList files={group.files} />
    </div>
  );
}

function ExportedFnRow({ item }: { item: ExportedFn }) {
  const { fn, file } = item;
  const params = fn.params.map((p) => `${p.type}${p.name ? ' ' + p.name : ''}`).join(', ');
  return (
    <div className="py-2.5 border-b border-gray-800/60 last:border-0">
      <div className="font-mono text-sm">
        <span className="text-gray-500">{fn.returnType} </span>
        <span className="text-gray-100">{fn.name}</span>
        <span className="text-gray-600">(</span>
        <span className="text-gray-400">{params}</span>
        <span className="text-gray-600">)</span>
      </div>
      <div className="text-xs text-gray-600 mt-0.5 font-mono">{file}</div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ExternalInterfacesSummary({ analysis }: ExternalInterfacesSummaryProps) {
  const ipcGroups = buildIpcGroups(analysis);
  const exportedFns = buildExportedFunctions(analysis);

  if (ipcGroups.length === 0 && exportedFns.length === 0) return null;

  return (
    <div className="mb-8 border border-gray-800 rounded-lg overflow-hidden">
      <div className="px-4 py-3 bg-gray-900/60 border-b border-gray-800">
        <h2 className="text-sm font-semibold text-gray-300">External Interfaces</h2>
        <p className="text-xs text-gray-600 mt-0.5">
          All communication mechanisms and callable API surface across {analysis.files.length} source file{analysis.files.length !== 1 ? 's' : ''}
        </p>
      </div>

      {/* IPC Mechanisms */}
      {ipcGroups.length > 0 && (
        <div className="px-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-gray-600 pt-3 pb-1">
            IPC Mechanisms
          </div>
          {ipcGroups.map((g) => <IpcGroupRow key={g.label} group={g} />)}
        </div>
      )}

      {/* Messaging Interfaces */}
      {analysis.messageInterfaces.length > 0 && (
        <div className="px-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-gray-600 pt-3 pb-1">
            Message Types
          </div>
          <div className="py-2 space-y-1">
            {analysis.messageInterfaces.map((msg) => (
              <div key={msg.msgTypeConstant} className="flex items-center gap-3 text-sm py-1 border-b border-gray-800/40 last:border-0">
                <span className="font-mono text-gray-200 w-48 shrink-0 truncate">{msg.msgTypeConstant}</span>
                <span className="font-mono text-gray-600 text-xs w-16 shrink-0">{msg.msgTypeValue}</span>
                <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${
                  msg.direction === 'producer' ? 'bg-blue-900/50 text-blue-300' :
                  msg.direction === 'consumer' ? 'bg-green-900/50 text-green-300' :
                  msg.direction === 'both'     ? 'bg-purple-900/50 text-purple-300' :
                                                 'bg-gray-800 text-gray-500'
                }`}>{msg.direction}</span>
                {msg.transport && (
                  <span className="text-xs text-gray-600 shrink-0">via {msg.transport}</span>
                )}
                {msg.struct && (
                  <span className="font-mono text-xs text-cyan-700 truncate">→ {msg.struct.name}</span>
                )}
                <span className="text-xs text-gray-700 truncate ml-auto">{msg.definedIn}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Exported API */}
      {exportedFns.length > 0 && (
        <div className="px-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-gray-600 pt-3 pb-1">
            Exported Functions ({exportedFns.length})
          </div>
          <div className="max-h-64 overflow-y-auto">
            {exportedFns.map((item, i) => <ExportedFnRow key={i} item={item} />)}
          </div>
        </div>
      )}

      <div className="h-3" /> {/* bottom padding */}
    </div>
  );
}
