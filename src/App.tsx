import { useState, useEffect, useCallback, useRef } from 'react';
import { initParser, analyzeString, FileRegistry, ingestFiles } from './analyzer';
import { PatternRegistry } from './analyzer/patternRegistry';
import { MsgStructRegistry } from './analyzer/msgStructRegistry';
import { saveFiles, loadFiles, clearFiles } from './utils/persistence';
import { findReferences } from './utils/findReferences';
import type { CustomPattern, FileAnalysis, FileRegistryEntry, FileZone, MsgStructPattern, StringAnalysis } from './analyzer/types';
import DropZone from './components/DropZone';
import FileList from './components/FileList';
import SummaryBar from './components/SummaryBar';
import FileTabs from './components/FileTabs';
import WarningBanner from './components/WarningBanner';
import PatternRegistryUI from './components/PatternRegistry';
import MsgStructPatternsUI from './components/MsgStructPatterns';
import ExternalInterfacesSummary from './components/ExternalInterfacesSummary';
import InterfaceGraph from './components/InterfaceGraph';
import FunctionsSection from './components/sections/FunctionsSection';
import IpcSection from './components/sections/IpcSection';
import StructsSection from './components/sections/StructsSection';
import ExternsSection from './components/sections/ExternsSection';
import DefinesSection from './components/sections/DefinesSection';
import UnknownsSection from './components/sections/UnknownsSection';
import RiskSection from './components/sections/RiskSection';

// Singletons (not React state — don't need to be reactive)
const fileRegistry = new FileRegistry();
const patternRegistry = new PatternRegistry();
const msgStructRegistry = new MsgStructRegistry();

export default function App() {
  const [parserReady, setParserReady] = useState(false);
  const [parserError, setParserError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<StringAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [allEntries, setAllEntries] = useState<FileRegistryEntry[]>([]);
  const [patterns, setPatterns] = useState<CustomPattern[]>(() => patternRegistry.getAll());
  const [msgStructPatterns, setMsgStructPatterns] = useState<MsgStructPattern[]>(() => msgStructRegistry.getAll());
  const [matchCounts, setMatchCounts] = useState<Map<string, number>>(new Map());
  const [msgStructMatchCounts, setMsgStructMatchCounts] = useState<Map<string, number>>(new Map());
  const [patternPrefill, setPatternPrefill] = useState<string | undefined>();
  const [msgStructPrefill, setMsgStructPrefill] = useState<string | undefined>();
  const [view, setView] = useState<'interfaces' | 'per-file'>('interfaces');

  // Ref mirrors parserReady so callbacks always see current value without stale closure
  const parserReadyRef = useRef(false);
  const analyzeInFlight = useRef(false);

  const runAnalysis = useCallback(async () => {
    if (!parserReadyRef.current || analyzeInFlight.current) return;
    analyzeInFlight.current = true;
    setAnalyzing(true);
    try {
      const result = await analyzeString(fileRegistry, patternRegistry.getAll(), msgStructRegistry.getAll());
      setAnalysis(result);
      const sourcetexts = fileRegistry.getSources().map((f) => f.content);
      setMatchCounts(patternRegistry.countMatches(sourcetexts));
      setMsgStructMatchCounts(msgStructRegistry.countMatches(result.typeDict.structs.map((s) => s.name), sourcetexts));
      setActiveFile((prev) => {
        if (prev && result.files.some((f) => f.filename === prev)) return prev;
        return result.files[0]?.filename ?? null;
      });
    } catch (e) {
      console.error('Analysis error:', e);
    } finally {
      analyzeInFlight.current = false;
      setAnalyzing(false);
    }
  }, []);

  // Initialize parser and restore persisted files on mount
  useEffect(() => {
    initParser()
      .then(async () => {
        parserReadyRef.current = true;
        setParserReady(true);
        try {
          const saved = await loadFiles();
          if (saved.length > 0) {
            fileRegistry.addFiles(saved);
            setAllEntries(fileRegistry.getAllEntries());
            await runAnalysis();
          }
        } catch {
          // Ignore persistence errors — start fresh
        }
      })
      .catch((e) => setParserError(String(e)));
  }, [runAnalysis]);

  async function handleFiles(files: File[], zone: FileZone) {
    const loaded = await ingestFiles(files, zone);
    fileRegistry.addFiles(loaded);
    setAllEntries(fileRegistry.getAllEntries());
    saveFiles(fileRegistry.getAll());
    await runAnalysis();
  }

  function handleRemove(filename: string, zone: FileZone) {
    fileRegistry.removeFile(filename, zone);
    setAllEntries(fileRegistry.getAllEntries());
    saveFiles(fileRegistry.getAll());
    runAnalysis();
  }

  function handleClearZone(zone: FileZone) {
    const toRemove = fileRegistry.getAllEntries()
      .filter((e) => e.file.zone === zone)
      .map((e) => e.file.filename);
    for (const filename of toRemove) {
      fileRegistry.removeFile(filename, zone);
    }
    setAllEntries(fileRegistry.getAllEntries());
    saveFiles(fileRegistry.getAll());
    runAnalysis();
  }

  async function handleClearSession() {
    fileRegistry.clear();
    patternRegistry.clear();
    msgStructRegistry.clear();
    setAllEntries([]);
    setAnalysis(null);
    setActiveFile(null);
    setPatterns([]);
    setMsgStructPatterns([]);
    await clearFiles();
  }

  function handleAddPattern(p: Omit<CustomPattern, 'id'>) {
    patternRegistry.add(p);
    setPatterns(patternRegistry.getAll());
  }

  function handleUpdatePattern(id: string, changes: Partial<Omit<CustomPattern, 'id'>>) {
    patternRegistry.update(id, changes);
    setPatterns(patternRegistry.getAll());
  }

  function handleRemovePattern(id: string) {
    patternRegistry.remove(id);
    setPatterns(patternRegistry.getAll());
  }

  function handleImportPatterns(imported: CustomPattern[]) {
    patternRegistry.importPatterns(imported);
    setPatterns(patternRegistry.getAll());
  }

  function handleAddMsgStructPattern(p: Omit<MsgStructPattern, 'id'>) {
    msgStructRegistry.add(p);
    setMsgStructPatterns(msgStructRegistry.getAll());
  }

  function handleRemoveMsgStructPattern(id: string) {
    msgStructRegistry.remove(id);
    setMsgStructPatterns(msgStructRegistry.getAll());
  }

  function handleImportMsgStructPatterns(imported: MsgStructPattern[]) {
    msgStructRegistry.importPatterns(imported);
    setMsgStructPatterns(msgStructRegistry.getAll());
  }

  function handleDetectMsgStructs(): number {
    if (!analysis) return 0;
    const sourceFiles = fileRegistry.getSources();
    const existingNames = new Set(msgStructPatterns.map((p) => p.name));
    let added = 0;
    for (const struct of analysis.typeDict.structs) {
      if (existingNames.has(struct.name)) continue;
      const refs = findReferences(struct.name, sourceFiles);
      if (refs.length >= 2) {
        msgStructRegistry.add({ name: struct.name, pattern: `^${struct.name}$` });
        existingNames.add(struct.name);
        added++;
      }
    }
    if (added > 0) setMsgStructPatterns(msgStructRegistry.getAll());
    return added;
  }

  function handleExportMsgStructPatterns() {
    const json = msgStructRegistry.exportAsJson();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cid-msg-struct-patterns.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleExportPatterns() {
    const json = patternRegistry.exportAsJson();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cid-patterns.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleExportTxt() {
    if (!analysis) return;
    const lines: string[] = [];
    lines.push('C Interface Discovery — Analysis Report');
    lines.push('='.repeat(60));
    lines.push('');

    if (analysis.warnings.length > 0) {
      lines.push('WARNINGS:');
      for (const w of analysis.warnings) lines.push(`  [${w.kind}] ${w.message}`);
      lines.push('');
    }

    for (const file of analysis.files) {
      lines.push(`FILE: ${file.filename}`);
      lines.push('-'.repeat(60));
      if (file.functions.length > 0) {
        lines.push('  FUNCTIONS:');
        for (const fn of file.functions) {
          lines.push(`    [${fn.direction}] ${fn.returnType} ${fn.name}(${fn.params.map((p) => `${p.type} ${p.name}`).join(', ')})`);
        }
      }
      if (file.ipc.length > 0) {
        lines.push('  IPC CALLS:');
        for (const c of file.ipc) lines.push(`    [${c.type}] ${c.detail}`);
      }
      if (file.externs.length > 0) {
        lines.push('  EXTERNS:');
        for (const e of file.externs) lines.push(`    [${e.kind}] ${e.dataType} ${e.name}`);
      }
      if (file.defines.length > 0) {
        lines.push('  DEFINES:');
        for (const d of file.defines) lines.push(`    [${d.category}] ${d.name} = ${d.value}`);
      }
      if (file.risks.length > 0) {
        lines.push('  RISKS:');
        for (const r of file.risks) lines.push(`    [${r.severity}] ${r.msg}`);
      }
      if (file.unknownCalls.length > 0) {
        lines.push('  UNKNOWN CALLS:');
        lines.push('    ' + file.unknownCalls.join(', '));
      }
      lines.push('');
    }

    if (analysis.messageInterfaces.length > 0) {
      lines.push('MESSAGE INTERFACES:');
      lines.push('='.repeat(60));
      for (const msg of analysis.messageInterfaces) {
        lines.push(`  ${msg.msgTypeConstant} = ${msg.msgTypeValue}`);
        lines.push(`    direction: ${msg.direction}${msg.directionConfident ? '' : ' (uncertain)'}`);
        lines.push(`    transport: ${msg.transport ?? 'unknown'}`);
        lines.push(`    defined in: ${msg.definedIn}`);
        if (msg.struct) {
          lines.push(`    struct: ${msg.struct.name} (${msg.struct.fields.length} fields)`);
        } else {
          lines.push('    struct: NOT RESOLVED');
        }
        lines.push('');
      }
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cid-report.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  const activeFileAnalysis: FileAnalysis | null =
    analysis?.files.find((f) => f.filename === activeFile) ?? null;

  // Structs visible in the active file: locally defined + typeDict structs referenced by name
  const activeFileContent = fileRegistry.getSources().find((f) => f.filename === activeFile)?.content ?? '';
  const activeFileStructs = activeFileAnalysis
    ? [
        ...activeFileAnalysis.structs,
        ...(analysis?.typeDict.structs.filter(
          (s) =>
            !activeFileAnalysis.structs.some((ls) => ls.name === s.name) &&
            activeFileContent.includes(s.name)
        ) ?? []),
      ]
    : [];

  const allWarnings = [
    ...fileRegistry.warnings,
    ...(analysis?.warnings.filter((w) => w.kind !== 'collision') ?? []),
  ];

  const fileCount = allEntries.filter((e) => !e.file.rejected).length;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-wide text-gray-100">C Interface Discovery</h1>
          <p className="text-xs text-gray-500 mt-0.5">Static analysis for legacy C messaging interfaces</p>
        </div>
        <div className="flex gap-2 items-center">
          {fileCount > 0 && (
            <button
              className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-red-900/60 text-gray-500 hover:text-red-300 rounded transition-colors"
              onClick={handleClearSession}
            >
              Clear session
            </button>
          )}
          {analysis && (
            <>
              <button
                className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded transition-colors"
                onClick={handleExportTxt}
              >
                ↓ Export TXT
              </button>
              <button
                className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded transition-colors"
                onClick={handleExportPatterns}
              >
                ↓ Export Patterns
              </button>
            </>
          )}
        </div>
      </header>

      <main className="px-6 py-6 max-w-6xl mx-auto">
        {/* Parser status */}
        {parserError && (
          <div className="mb-4 p-3 border border-red-800 bg-red-950/30 rounded text-red-400 text-sm">
            Parser initialization failed: {parserError}
          </div>
        )}
        {!parserReady && !parserError && (
          <div className="mb-4 p-3 border border-gray-800 bg-gray-900/30 rounded text-gray-500 text-sm">
            Initializing tree-sitter parser…
          </div>
        )}

        {/* Drop zones */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          {(['string', 'external'] as FileZone[]).map((zone) => {
            const zoneCount = allEntries.filter((e) => e.file.zone === zone).length;
            return (
              <div key={zone}>
                <DropZone
                  zone={zone}
                  onFiles={(files) => handleFiles(files, zone)}
                  label={zone === 'string' ? 'SOURCE FILES' : 'EXTERNAL INCLUDES'}
                  accept={zone === 'string' ? '.c,.h,.cpp' : '.h'}
                  description={zone === 'string'
                    ? 'Drop the source directory here (.c and .h)'
                    : 'Drop shared include directory files here (.h only)'}
                />
                {zoneCount > 0 && (
                  <div className="flex justify-end mt-1.5 mb-0.5">
                    <button
                      className="text-xs text-gray-600 hover:text-red-400 transition-colors"
                      onClick={() => handleClearZone(zone)}
                    >
                      Clear all ({zoneCount})
                    </button>
                  </div>
                )}
                <FileList entries={allEntries} zone={zone} onRemove={handleRemove} />
              </div>
            );
          })}
        </div>

        {/* Analysis section */}
        {(analysis || analyzing) && (
          <>
            {analyzing && (
              <div className="mb-4 text-xs text-gray-500 animate-pulse">Analyzing…</div>
            )}

            <WarningBanner warnings={allWarnings} />
            <SummaryBar analysis={analysis} />

            {analysis && (
              <>
                {/* ── Graph (always visible) ────────────────────────────── */}
                <div className="mb-6">
                  <InterfaceGraph
                    analysis={analysis}
                    onSelectFile={(filename) => {
                      setActiveFile(filename);
                      setView('per-file');
                    }}
                  />
                </div>

                {/* ── View tabs ─────────────────────────────────────────── */}
                <div className="flex gap-1 mb-4 border-b border-gray-800 pb-0">
                  {([
                    { id: 'interfaces', label: 'Interfaces' },
                    { id: 'per-file',   label: 'Per-file' },
                  ] as const).map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setView(tab.id)}
                      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
                        view === tab.id
                          ? 'border-blue-500 text-blue-400'
                          : 'border-transparent text-gray-500 hover:text-gray-300'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {/* ── Interfaces tab ────────────────────────────────────── */}
                {view === 'interfaces' && (
                  <ExternalInterfacesSummary analysis={analysis} sourceFiles={fileRegistry.getSources()} />
                )}

                {/* ── Per-file tab ──────────────────────────────────────── */}
                {view === 'per-file' && (
                  <div>
                    <FileTabs
                      files={analysis.files}
                      activeFile={activeFile}
                      onSelect={setActiveFile}
                    />
                    {activeFileAnalysis && (
                      <div className="space-y-2 mt-2">
                        <FunctionsSection functions={activeFileAnalysis.functions} />
                        <IpcSection ipc={activeFileAnalysis.ipc} />
                        <StructsSection
                          structs={activeFileStructs}
                          sourceFiles={fileRegistry.getSources()}
                          onAddAsMsgStructPattern={(name) => setMsgStructPrefill(name)}
                        />
                        <ExternsSection externs={activeFileAnalysis.externs} />
                        <DefinesSection defines={activeFileAnalysis.defines} />
                        <UnknownsSection
                          unknownCalls={activeFileAnalysis.unknownCalls}
                          onAddAsPattern={(fn) => setPatternPrefill(fn)}
                        />
                        <RiskSection risks={activeFileAnalysis.risks} />
                      </div>
                    )}
                  </div>
                )}


                {/* ── Custom patterns ───────────────────────────────────── */}
                <div className="mt-8 border-t border-gray-800 pt-6">
                  <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-3">
                    Custom Patterns
                  </h2>
                  <div className="space-y-2">
                    <PatternRegistryUI
                      patterns={patterns}
                      onAdd={handleAddPattern}
                      onUpdate={handleUpdatePattern}
                      onRemove={handleRemovePattern}
                      onImport={handleImportPatterns}
                      onExport={handleExportPatterns}
                      onReanalyze={runAnalysis}
                      matchCounts={matchCounts}
                      prefill={patternPrefill}
                    />
                    <MsgStructPatternsUI
                      patterns={msgStructPatterns}
                      onAdd={handleAddMsgStructPattern}
                      onRemove={handleRemoveMsgStructPattern}
                      onImport={handleImportMsgStructPatterns}
                      onExport={handleExportMsgStructPatterns}
                      onReanalyze={runAnalysis}
                      onDetect={handleDetectMsgStructs}
                      prefill={msgStructPrefill}
                      matchCounts={msgStructMatchCounts}
                    />
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
