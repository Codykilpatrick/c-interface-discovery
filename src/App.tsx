import { useState, useEffect, useCallback, useRef } from 'react';
import { initParser, analyzeString, FileRegistry, ingestFiles } from './analyzer';
import { PatternRegistry } from './analyzer/patternRegistry';
import type { CustomPattern, FileAnalysis, FileRegistryEntry, FileZone, StringAnalysis } from './analyzer/types';
import DropZone from './components/DropZone';
import FileList from './components/FileList';
import SummaryBar from './components/SummaryBar';
import FileTabs from './components/FileTabs';
import WarningBanner from './components/WarningBanner';
import PatternRegistryUI from './components/PatternRegistry';
import MessagingSection from './components/sections/MessagingSection';
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

export default function App() {
  const [parserReady, setParserReady] = useState(false);
  const [parserError, setParserError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<StringAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [allEntries, setAllEntries] = useState<FileRegistryEntry[]>([]);
  const [patterns, setPatterns] = useState<CustomPattern[]>([]);
  const [matchCounts, setMatchCounts] = useState<Map<string, number>>(new Map());

  // Use a ref to prevent concurrent analyses
  const analyzeInFlight = useRef(false);

  // Initialize tree-sitter parser on mount
  useEffect(() => {
    initParser()
      .then(() => setParserReady(true))
      .catch((e) => setParserError(String(e)));
  }, []);

  const runAnalysis = useCallback(async () => {
    if (!parserReady || analyzeInFlight.current) return;
    analyzeInFlight.current = true;
    setAnalyzing(true);
    try {
      const result = await analyzeString(fileRegistry, patternRegistry.getAll());
      setAnalysis(result);
      // Update match counts for pattern registry UI
      const sourcetexts = fileRegistry.getSources().map((f) => f.content);
      setMatchCounts(patternRegistry.countMatches(sourcetexts));
      // Default to first source file if none selected
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
  }, [parserReady]);

  async function handleFiles(files: File[], zone: FileZone) {
    const loaded = await ingestFiles(files, zone);
    fileRegistry.addFiles(loaded);
    setAllEntries(fileRegistry.getAllEntries());
    await runAnalysis();
  }

  function handleRemove(filename: string, zone: FileZone) {
    fileRegistry.removeFile(filename, zone);
    setAllEntries(fileRegistry.getAllEntries());
    runAnalysis();
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

  const allWarnings = [
    ...(fileRegistry.warnings),
    ...(analysis?.warnings.filter((w) => w.kind !== 'collision') ?? []),
  ];

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-wide text-gray-100">C Interface Discovery</h1>
          <p className="text-xs text-gray-500 mt-0.5">Static analysis for legacy C messaging interfaces</p>
        </div>
        <div className="flex gap-2">
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
          <div>
            <DropZone
              zone="string"
              onFiles={(files) => handleFiles(files, 'string')}
              label="SOURCE FILES"
              accept=".c,.h,.cpp"
              description="Drop the source directory here (.c and .h)"
            />
            <FileList entries={allEntries} zone="string" onRemove={handleRemove} />
          </div>
          <div>
            <DropZone
              zone="external"
              onFiles={(files) => handleFiles(files, 'external')}
              label="EXTERNAL INCLUDES"
              accept=".h"
              description="Drop shared include directory files here (.h only)"
            />
            <FileList entries={allEntries} zone="external" onRemove={handleRemove} />
          </div>
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
                <FileTabs
                  files={analysis.files}
                  activeFile={activeFile}
                  onSelect={setActiveFile}
                />

                {/* Global messaging section */}
                <MessagingSection messages={analysis.messageInterfaces} />

                {/* Per-file sections */}
                {activeFileAnalysis && (
                  <div className="space-y-2 mt-4">
                    <FunctionsSection functions={activeFileAnalysis.functions} />
                    <IpcSection ipc={activeFileAnalysis.ipc} />
                    <StructsSection structs={activeFileAnalysis.structs} />
                    <ExternsSection externs={activeFileAnalysis.externs} />
                    <DefinesSection defines={activeFileAnalysis.defines} />
                    <UnknownsSection unknownCalls={activeFileAnalysis.unknownCalls} />
                    <RiskSection risks={activeFileAnalysis.risks} />
                  </div>
                )}

                {/* Pattern registry */}
                <div className="mt-6">
                  <PatternRegistryUI
                    patterns={patterns}
                    onAdd={handleAddPattern}
                    onUpdate={handleUpdatePattern}
                    onRemove={handleRemovePattern}
                    onImport={handleImportPatterns}
                    onExport={handleExportPatterns}
                    onReanalyze={runAnalysis}
                    matchCounts={matchCounts}
                  />
                </div>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
