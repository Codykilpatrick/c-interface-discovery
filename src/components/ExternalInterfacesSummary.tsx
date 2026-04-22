import type { CFunction, FileRef, IpcType, LoadedFile, MessageInterface, StringAnalysis } from '../analyzer/types';
import { useState } from 'react';
import { findReferences } from '../utils/findReferences';

interface ExternalInterfacesSummaryProps {
  analysis: StringAnalysis;
  sourceFiles: LoadedFile[];
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
  callNames: string[];
  files: string[];
}

interface ExportedFn {
  fn: CFunction;
  file: string;
}

function callName(detail: string): string {
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

// ── Shared: inline reference lines ───────────────────────────────────────────

function RefLines({ refs }: { refs: FileRef[] }) {
  if (refs.length === 0) return <p className="text-xs text-gray-600 italic px-1">No references found</p>;
  return (
    <div className="space-y-2 mt-1">
      {refs.map((r) => (
        <div key={r.filename}>
          <div className="text-xs font-mono text-gray-500 mb-0.5">{r.filename}</div>
          {r.lines.map((l) => (
            <div key={l.lineNumber} className="flex gap-2 font-mono text-xs leading-5">
              <span className="text-gray-700 w-8 shrink-0 text-right select-none">{l.lineNumber}</span>
              <span className="text-gray-400 truncate">{l.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ── Struct reference popup ────────────────────────────────────────────────────

function StructRefLink({ structName, sourceFiles }: { structName: string; sourceFiles: LoadedFile[] }) {
  const [open, setOpen] = useState(false);
  const [refs, setRefs] = useState<FileRef[] | null>(null);

  function toggle() {
    if (!open && refs === null) {
      setRefs(findReferences(structName, sourceFiles));
    }
    setOpen((v) => !v);
  }

  return (
    <span className="inline-block">
      <button
        className="font-mono text-xs text-cyan-600 hover:text-cyan-400 transition-colors underline underline-offset-2 decoration-dotted"
        onClick={(e) => { e.stopPropagation(); toggle(); }}
        title="Show struct references"
      >
        → {structName}
      </button>
      {open && refs !== null && (
        <div className="mt-2 bg-gray-900 border border-gray-700 rounded p-2 text-left">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-gray-500 font-mono">{structName} references</span>
            <button className="text-gray-600 hover:text-gray-400 text-xs ml-4" onClick={(e) => { e.stopPropagation(); setOpen(false); }}>✕</button>
          </div>
          <RefLines refs={refs} />
        </div>
      )}
    </span>
  );
}

// ── Message type row ──────────────────────────────────────────────────────────

function MsgTypeRow({ msg, sourceFiles, forceOpen }: { msg: MessageInterface; sourceFiles: LoadedFile[]; forceOpen?: boolean }) {
  const [open, setOpen] = useState(false);
  const hasRefs = msg.usedIn.length > 0;
  const isOpen = forceOpen || open;

  return (
    <div className="border-b border-gray-800/40 last:border-0">
      <button
        className={`w-full flex items-center gap-3 text-sm py-1.5 text-left transition-colors ${hasRefs ? 'hover:bg-gray-800/30 cursor-pointer' : 'cursor-default'}`}
        onClick={() => hasRefs && setOpen((v) => !v)}
        title={hasRefs ? 'Click to see file references' : undefined}
      >
        {hasRefs && (
          <span className="text-gray-700 text-xs w-3 shrink-0">{isOpen ? '▼' : '▶'}</span>
        )}
        {!hasRefs && <span className="w-3 shrink-0" />}
        <span className="font-mono text-gray-200 w-44 shrink-0 truncate">{msg.msgTypeConstant}</span>
        <span className="font-mono text-gray-600 text-xs w-14 shrink-0">{msg.msgTypeValue}</span>
        <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${
          msg.direction === 'producer' ? 'bg-blue-900/50 text-blue-300' :
          msg.direction === 'consumer' ? 'bg-green-900/50 text-green-300' :
          msg.direction === 'both'     ? 'bg-purple-900/50 text-purple-300' :
                                         'bg-gray-800 text-gray-500'
        }`}>{msg.direction}</span>
        {msg.transport && (
          <span className="text-xs text-gray-600 shrink-0">via {msg.transport}</span>
        )}
        {msg.struct ? (
          <span onClick={(e) => e.stopPropagation()}>
            <StructRefLink structName={msg.struct.name} sourceFiles={sourceFiles} />
          </span>
        ) : (
          <span className="text-xs text-gray-700">struct unresolved</span>
        )}
        <span className="text-xs text-gray-700 truncate ml-auto">{msg.definedIn}</span>
      </button>

      {isOpen && (
        <div className="pl-6 pr-3 pb-2 bg-gray-900/40">
          <RefLines refs={msg.usedIn} />
        </div>
      )}
    </div>
  );
}

// ── IPC group ─────────────────────────────────────────────────────────────────

function FileBadges({ files }: { files: string[] }) {
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
      <FileBadges files={group.files} />
    </div>
  );
}

// ── Exported function row ─────────────────────────────────────────────────────

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

export default function ExternalInterfacesSummary({ analysis, sourceFiles }: ExternalInterfacesSummaryProps) {
  const ipcGroups = buildIpcGroups(analysis);
  const exportedFns = buildExportedFunctions(analysis);
  const [msgQuery, setMsgQuery] = useState('');

  if (ipcGroups.length === 0 && exportedFns.length === 0) return null;

  const q = msgQuery.trim().toLowerCase();
  const filteredMsgs = q
    ? analysis.messageInterfaces.filter(
        (m) =>
          m.msgTypeConstant.toLowerCase().includes(q) ||
          m.msgTypeValue.toLowerCase().includes(q)
      )
    : analysis.messageInterfaces;
  const autoExpand = filteredMsgs.length === 1;

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
          <div className="flex items-center justify-between pt-3 pb-1 gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-600 shrink-0">
              Message Types
              <span className="ml-2 font-normal normal-case text-gray-700">(click row to see references)</span>
            </span>
            <input
              type="text"
              value={msgQuery}
              onChange={(e) => setMsgQuery(e.target.value)}
              placeholder="Search message constants…"
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs font-mono text-gray-300 placeholder-gray-600 focus:outline-none focus:border-gray-500 w-52"
            />
          </div>
          <div className="py-1">
            {filteredMsgs.length > 0 ? (
              filteredMsgs.map((msg) => (
                <MsgTypeRow key={msg.msgTypeConstant} msg={msg} sourceFiles={sourceFiles} forceOpen={autoExpand} />
              ))
            ) : (
              <div className="py-3 text-xs text-gray-600 italic">No message constants match "{msgQuery}"</div>
            )}
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
            {exportedFns.map((item) => <ExportedFnRow key={`${item.file}:${item.fn.name}`} item={item} />)}
          </div>
        </div>
      )}

      <div className="h-3" />
    </div>
  );
}
