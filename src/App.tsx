import { useState, useEffect, useCallback, useRef } from 'react';
import { initParser, analyzeString, FileRegistry, ingestFiles } from './analyzer';
import { PatternRegistry } from './analyzer/patternRegistry';
import { MsgStructRegistry } from './analyzer/msgStructRegistry';
import {
  saveAppMeta, loadAppMeta, saveSession, loadSession, clearSession,
} from './utils/persistence';
import { findReferences } from './utils/findReferences';
import type {
  ApplicationGroup,
  CustomPattern,
  FileAnalysis,
  FileRegistryEntry,
  LoadedFile,
  MsgStructPattern,
  StringAnalysis,
} from './analyzer/types';
import AppZone from './components/AppZone';
import DropZone from './components/DropZone';
import FileList from './components/FileList';
import SummaryBar from './components/SummaryBar';
import FileTabs from './components/FileTabs';
import WarningBanner from './components/WarningBanner';
import PatternRegistryUI from './components/PatternRegistry';
import MsgStructPatternsUI from './components/MsgStructPatterns';
import ExternalInterfacesSummary from './components/ExternalInterfacesSummary';
import ApplicationGraph from './components/ApplicationGraph';
import InterfaceGraph from './components/InterfaceGraph';
import FunctionsSection from './components/sections/FunctionsSection';
import IpcSection from './components/sections/IpcSection';
import StructsSection from './components/sections/StructsSection';
import ExternsSection from './components/sections/ExternsSection';
import DefinesSection from './components/sections/DefinesSection';
import UnknownsSection from './components/sections/UnknownsSection';
import RiskSection from './components/sections/RiskSection';

function genId(): string {
  return Math.random().toString(36).slice(2, 11);
}

function makeDefaultApp(index: number): ApplicationGroup {
  return { id: genId(), name: `Application ${index}`, files: [], analysis: null };
}

// Singletons — not React state
const patternRegistry = new PatternRegistry();
const msgStructRegistry = new MsgStructRegistry();

export default function App() {
  const [parserReady, setParserReady] = useState(false);
  const [parserError, setParserError] = useState<string | null>(null);

  const [applications, setApplications] = useState<ApplicationGroup[]>([makeDefaultApp(1)]);
  const [externalFiles, setExternalFiles] = useState<LoadedFile[]>([]);
  const [externalEntries, setExternalEntries] = useState<FileRegistryEntry[]>([]);
  const [analyzingApps, setAnalyzingApps] = useState<Set<string>>(new Set());

  // null = app-level view; string = drill-down into that app
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [view, setView] = useState<'interfaces' | 'per-file'>('interfaces');

  const [patterns, setPatterns] = useState<CustomPattern[]>(() => patternRegistry.getAll());
  const [msgStructPatterns, setMsgStructPatterns] = useState<MsgStructPattern[]>(() => msgStructRegistry.getAll());
  const [matchCounts, setMatchCounts] = useState<Map<string, number>>(new Map());
  const [msgStructMatchCounts, setMsgStructMatchCounts] = useState<Map<string, number>>(new Map());
  const [patternPrefill, setPatternPrefill] = useState<string | undefined>();
  const [msgStructPrefill, setMsgStructPrefill] = useState<string | undefined>();

  // Refs to avoid stale closures
  const parserReadyRef = useRef(false);
  const externalRegistryRef = useRef(new FileRegistry());
  const analyzeInFlightApps = useRef(new Set<string>());

  // ── Core analysis ──────────────────────────────────────────────────────────

  const runAnalysisForApp = useCallback(async (
    appId: string,
    appFiles: LoadedFile[],
    extFiles: LoadedFile[],
  ): Promise<StringAnalysis | null> => {
    if (!parserReadyRef.current) return null;
    if (analyzeInFlightApps.current.has(appId)) return null;

    const hasSources = appFiles.some((f) => /\.(c|cpp)$/i.test(f.filename));
    if (!hasSources) {
      setApplications((prev) => prev.map((a) => a.id === appId ? { ...a, analysis: null } : a));
      return null;
    }

    analyzeInFlightApps.current.add(appId);
    setAnalyzingApps((prev) => new Set([...prev, appId]));

    try {
      const tempRegistry = new FileRegistry();
      tempRegistry.addFiles([...appFiles, ...extFiles]);
      const result = await analyzeString(tempRegistry, patternRegistry.getAll(), msgStructRegistry.getAll());

      setApplications((prev) => prev.map((a) => a.id === appId ? { ...a, analysis: result } : a));
      return result;
    } catch (e) {
      console.error(`Analysis error for app ${appId}:`, e);
      return null;
    } finally {
      analyzeInFlightApps.current.delete(appId);
      setAnalyzingApps((prev) => {
        const next = new Set(prev);
        next.delete(appId);
        return next;
      });
    }
  }, []);

  // Update match counts from all apps' source texts
  function refreshMatchCounts(apps: ApplicationGroup[]) {
    const allSourceTexts = apps.flatMap((a) =>
      a.files.filter((f) => /\.(c|cpp)$/i.test(f.filename)).map((f) => f.content)
    );
    if (allSourceTexts.length === 0) return;
    setMatchCounts(patternRegistry.countMatches(allSourceTexts));

    const allStructNames = apps.flatMap((a) => a.analysis?.typeDict.structs.map((s) => s.name) ?? []);
    setMsgStructMatchCounts(msgStructRegistry.countMatches(allStructNames, allSourceTexts));
  }

  async function reanalyzeAllApps(currentApps: ApplicationGroup[], extFiles: LoadedFile[]) {
    const results = await Promise.all(
      currentApps.map(async (app) => ({
        id: app.id,
        result: await runAnalysisForApp(app.id, app.files, extFiles),
      }))
    );
    const appsWithResults = currentApps.map((app) => {
      const r = results.find((x) => x.id === app.id);
      return r?.result ? { ...app, analysis: r.result } : app;
    });
    refreshMatchCounts(appsWithResults);
  }

  // ── Initialization & session restore ──────────────────────────────────────

  useEffect(() => {
    initParser()
      .then(async () => {
        parserReadyRef.current = true;
        setParserReady(true);

        try {
          const meta = loadAppMeta();
          const { filesPerApp, externalFiles: savedExtFiles } = await loadSession();

          // Restore external files
          externalRegistryRef.current.addFiles(savedExtFiles);
          setExternalFiles(savedExtFiles);
          setExternalEntries(externalRegistryRef.current.getAllEntries());

          if (meta && meta.length > 0 && filesPerApp.size > 0) {
            const restoredApps: ApplicationGroup[] = meta.map((m) => ({
              id: m.id,
              name: m.name,
              files: filesPerApp.get(m.id) ?? [],
              analysis: null,
            }));
            setApplications(restoredApps);
            // Run analysis for all apps with source files
            await Promise.all(
              restoredApps.map((app) => runAnalysisForApp(app.id, app.files, savedExtFiles))
            );
          }
        } catch {
          // Ignore persistence errors
        }
      })
      .catch((e) => setParserError(String(e)));
  }, [runAnalysisForApp]);

  // ── App management ─────────────────────────────────────────────────────────

  function handleAddApp() {
    const newApp = makeDefaultApp(applications.length + 1);
    const updated = [...applications, newApp];
    setApplications(updated);
    saveAppMeta(updated.map((a) => ({ id: a.id, name: a.name })));
  }

  function handleRemoveApp(appId: string) {
    if (applications.length <= 1) return;
    const updated = applications.filter((a) => a.id !== appId);
    setApplications(updated);
    saveAppMeta(updated.map((a) => ({ id: a.id, name: a.name })));
    saveSession(updated, externalFiles);
    if (selectedAppId === appId) setSelectedAppId(null);
  }

  function handleRenameApp(appId: string, name: string) {
    const updated = applications.map((a) => a.id === appId ? { ...a, name } : a);
    setApplications(updated);
    saveAppMeta(updated.map((a) => ({ id: a.id, name: a.name })));
  }

  // ── App file management ────────────────────────────────────────────────────

  async function handleAppFiles(appId: string, files: File[]) {
    const loaded = await ingestFiles(files, 'string');
    const app = applications.find((a) => a.id === appId);
    if (!app) return;

    const updatedFiles = mergeFiles(app.files, loaded);
    const updatedApps = applications.map((a) =>
      a.id === appId ? { ...a, files: updatedFiles } : a
    );
    setApplications(updatedApps);

    const extFiles = externalRegistryRef.current.getAll();
    const result = await runAnalysisForApp(appId, updatedFiles, extFiles);
    const appsWithResult = updatedApps.map((a) =>
      a.id === appId && result ? { ...a, analysis: result } : a
    );
    refreshMatchCounts(appsWithResult);
    saveSession(updatedApps, extFiles);
    saveAppMeta(updatedApps.map((a) => ({ id: a.id, name: a.name })));
  }

  async function handleRemoveAppFile(appId: string, filename: string) {
    const app = applications.find((a) => a.id === appId);
    if (!app) return;

    const updatedFiles = app.files.filter((f) => f.filename !== filename);
    const updatedApps = applications.map((a) =>
      a.id === appId ? { ...a, files: updatedFiles } : a
    );
    setApplications(updatedApps);

    const extFiles = externalRegistryRef.current.getAll();
    await runAnalysisForApp(appId, updatedFiles, extFiles);
    refreshMatchCounts(updatedApps);
    saveSession(updatedApps, extFiles);
  }

  async function handleClearApp(appId: string) {
    const updatedApps = applications.map((a) =>
      a.id === appId ? { ...a, files: [], analysis: null } : a
    );
    setApplications(updatedApps);
    saveSession(updatedApps, externalFiles);
  }

  // Merge new files into existing, replacing by filename
  function mergeFiles(existing: LoadedFile[], incoming: LoadedFile[]): LoadedFile[] {
    const map = new Map(existing.map((f) => [f.filename, f]));
    for (const f of incoming) map.set(f.filename, f);
    return [...map.values()];
  }

  // ── External file management ───────────────────────────────────────────────

  async function handleExternalFiles(files: File[]) {
    const loaded = await ingestFiles(files, 'external');
    externalRegistryRef.current.addFiles(loaded);
    const extFiles = externalRegistryRef.current.getAll();
    setExternalFiles(extFiles);
    setExternalEntries(externalRegistryRef.current.getAllEntries());

    const currentApps = applications;
    await reanalyzeAllApps(currentApps, extFiles);
    saveSession(currentApps, extFiles);
  }

  async function handleRemoveExternal(filename: string) {
    externalRegistryRef.current.removeFile(filename, 'external');
    const extFiles = externalRegistryRef.current.getAll();
    setExternalFiles(extFiles);
    setExternalEntries(externalRegistryRef.current.getAllEntries());

    const currentApps = applications;
    await reanalyzeAllApps(currentApps, extFiles);
    saveSession(currentApps, extFiles);
  }

  async function handleClearExternal() {
    externalRegistryRef.current.clear();
    setExternalFiles([]);
    setExternalEntries([]);

    const currentApps = applications;
    await reanalyzeAllApps(currentApps, []);
    saveSession(currentApps, []);
  }

  // ── Session ────────────────────────────────────────────────────────────────

  async function handleClearSession() {
    const fresh = [makeDefaultApp(1)];
    setApplications(fresh);
    setExternalFiles([]);
    setExternalEntries([]);
    externalRegistryRef.current.clear();
    setSelectedAppId(null);
    setActiveFile(null);
    patternRegistry.clear();
    msgStructRegistry.clear();
    setPatterns([]);
    setMsgStructPatterns([]);
    setMatchCounts(new Map());
    setMsgStructMatchCounts(new Map());
    await clearSession();
  }

  // ── Patterns ───────────────────────────────────────────────────────────────

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
    // Detect across all apps
    const allSourceFiles = applications.flatMap((a) =>
      a.files.filter((f) => /\.(c|cpp)$/i.test(f.filename))
    );
    const allStructs = applications.flatMap((a) => a.analysis?.typeDict.structs ?? []);
    const existingNames = new Set(msgStructPatterns.map((p) => p.name));
    let added = 0;

    // Pass 1: structs from typeDict that appear in 2+ source files
    for (const struct of allStructs) {
      if (existingNames.has(struct.name)) continue;
      const refs = findReferences(struct.name, allSourceFiles);
      if (refs.length >= 2) {
        msgStructRegistry.add({ name: struct.name, pattern: `^${struct.name}$` });
        existingNames.add(struct.name);
        added++;
      }
    }

    // Pass 2: structs implied by IPC wrapper function parameters (already resolved in typeDict)
    // These may only appear in one file but are strong candidates since they're directly in IPC calls.
    const allIpcCalls = applications.flatMap((a) =>
      a.analysis?.files.flatMap((f) => f.ipc) ?? []
    );
    for (const call of allIpcCalls) {
      for (const structName of call.impliedStructs ?? []) {
        if (existingNames.has(structName)) continue;
        msgStructRegistry.add({ name: structName, pattern: `^${structName}$` });
        existingNames.add(structName);
        added++;
      }
    }

    // Pass 3: candidate types from IPC wrapper params that weren't in typeDict —
    // these come from unresolved external headers. Only add if they at least appear
    // in one source file (to avoid primitive/void false positives).
    const knownStructNames = new Set(allStructs.map((s) => s.name));
    for (const call of allIpcCalls) {
      for (const typeName of call.candidateTypes ?? []) {
        if (existingNames.has(typeName)) continue;
        if (knownStructNames.has(typeName)) continue; // already handled in pass 1
        const refs = findReferences(typeName, allSourceFiles);
        if (refs.length >= 1) {
          msgStructRegistry.add({ name: typeName, pattern: `^${typeName}$` });
          existingNames.add(typeName);
          added++;
        }
      }
    }

    if (added > 0) setMsgStructPatterns(msgStructRegistry.getAll());
    return added;
  }

  async function handleReanalyze() {
    await reanalyzeAllApps(applications, externalFiles);
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  function handleExportPatterns() {
    const json = patternRegistry.exportAsJson();
    downloadBlob(json, 'application/json', 'cid-patterns.json');
  }

  function handleExportMsgStructPatterns() {
    downloadBlob(msgStructRegistry.exportAsJson(), 'application/json', 'cid-msg-struct-patterns.json');
  }

  function handleExportConfig() {
    const config = JSON.stringify({
      version: 1,
      customPatterns: patternRegistry.getAll(),
      msgStructPatterns: msgStructRegistry.getAll(),
    }, null, 2);
    downloadBlob(config, 'application/json', 'cid-config.json');
  }

  function handleImportConfig(json: string) {
    try {
      const parsed = JSON.parse(json);
      // Combined format: { version, customPatterns, msgStructPatterns }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (Array.isArray(parsed.customPatterns)) {
          patternRegistry.importPatterns(parsed.customPatterns as CustomPattern[]);
          setPatterns(patternRegistry.getAll());
        }
        if (Array.isArray(parsed.msgStructPatterns)) {
          msgStructRegistry.importPatterns(parsed.msgStructPatterns as MsgStructPattern[]);
          setMsgStructPatterns(msgStructRegistry.getAll());
        }
        return;
      }
      // Legacy: plain array — detect type by shape
      if (Array.isArray(parsed) && parsed.length > 0) {
        if ('ipcType' in parsed[0]) {
          patternRegistry.importPatterns(parsed as CustomPattern[]);
          setPatterns(patternRegistry.getAll());
        } else {
          msgStructRegistry.importPatterns(parsed as MsgStructPattern[]);
          setMsgStructPatterns(msgStructRegistry.getAll());
        }
      }
    } catch {
      alert('Invalid config file — expected JSON');
    }
  }

  function handleExportTxt(analysis: StringAnalysis, appName: string) {
    const lines: string[] = [];
    lines.push(`C Interface Discovery — ${appName}`);
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
      if (file.risks.length > 0) {
        lines.push('  RISKS:');
        for (const r of file.risks) lines.push(`    [${r.severity}] ${r.msg}`);
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
        lines.push(`    struct: ${msg.struct ? msg.struct.name : 'NOT RESOLVED'}`);
        lines.push('');
      }
    }

    downloadBlob(lines.join('\n'), 'text/plain', `cid-${appName.toLowerCase().replace(/\s+/g, '-')}.txt`);
  }

  function downloadBlob(content: string, type: string, filename: string) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Derived state for drill-down ───────────────────────────────────────────

  const selectedApp = applications.find((a) => a.id === selectedAppId) ?? null;
  const selectedAnalysis = selectedApp?.analysis ?? null;

  const activeFileAnalysis: FileAnalysis | null =
    selectedAnalysis?.files.find((f) => f.filename === activeFile) ?? null;

  const activeFileContent = selectedApp?.files.find((f) => f.filename === activeFile)?.content ?? '';
  const activeFileStructs = activeFileAnalysis
    ? [
        ...activeFileAnalysis.structs,
        ...(selectedAnalysis?.typeDict.structs.filter(
          (s) =>
            !activeFileAnalysis.structs.some((ls) => ls.name === s.name) &&
            activeFileContent.includes(s.name)
        ) ?? []),
      ]
    : [];

  // ── Misc ───────────────────────────────────────────────────────────────────

  const anyAnalyzing = analyzingApps.size > 0;
  const hasAnyFiles = applications.some((a) => a.files.length > 0) || externalFiles.length > 0;
  const hasAnyAnalysis = applications.some((a) => a.analysis !== null);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div>
          {selectedApp ? (
            <div className="flex items-center gap-2">
              <button
                className="text-gray-500 hover:text-gray-300 text-sm transition-colors"
                onClick={() => setSelectedAppId(null)}
              >
                ← All Applications
              </button>
              <span className="text-gray-700">/</span>
              <span className="text-lg font-semibold text-gray-100">{selectedApp.name}</span>
            </div>
          ) : (
            <div>
              <h1 className="text-lg font-semibold tracking-wide text-gray-100">C Interface Discovery</h1>
              <p className="text-xs text-gray-500 mt-0.5">Static analysis for legacy C messaging interfaces</p>
            </div>
          )}
        </div>
        <div className="flex gap-2 items-center">
          {hasAnyFiles && (
            <button
              className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-red-900/60 text-gray-500 hover:text-red-300 rounded transition-colors"
              onClick={handleClearSession}
            >
              Clear session
            </button>
          )}
          {selectedAnalysis && (
            <>
              <button
                className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded transition-colors"
                onClick={() => handleExportTxt(selectedAnalysis, selectedApp!.name)}
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

        {/* ── DRILL-DOWN VIEW ─────────────────────────────────────────────── */}
        {selectedApp && (
          <DrillDownView
            app={selectedApp}
            analysis={selectedAnalysis}
            analyzing={analyzingApps.has(selectedApp.id)}
            activeFile={activeFile}
            setActiveFile={(f) => {
              setActiveFile(f);
              setView('per-file');
              window.scrollTo({ top: 0, behavior: 'instant' });
            }}
            activeFileAnalysis={activeFileAnalysis}
            activeFileStructs={activeFileStructs}
            view={view}
            setView={setView}
            sourceFiles={selectedApp.files.filter((f) => /\.(c|cpp)$/i.test(f.filename))}
            onAddAsPattern={setPatternPrefill}
            onAddAsMsgStructPattern={setMsgStructPrefill}
            patterns={patterns}
            onAddPattern={handleAddPattern}
            onUpdatePattern={handleUpdatePattern}
            onRemovePattern={handleRemovePattern}
            onImportPatterns={handleImportPatterns}
            onExportPatterns={handleExportPatterns}
            onReanalyze={handleReanalyze}
            matchCounts={matchCounts}
            patternPrefill={patternPrefill}
            msgStructPatterns={msgStructPatterns}
            onAddMsgStructPattern={handleAddMsgStructPattern}
            onRemoveMsgStructPattern={handleRemoveMsgStructPattern}
            onImportMsgStructPatterns={handleImportMsgStructPatterns}
            onExportMsgStructPatterns={handleExportMsgStructPatterns}
            onExportConfig={handleExportConfig}
            onImportConfig={handleImportConfig}
            onDetectMsgStructs={handleDetectMsgStructs}
            msgStructPrefill={msgStructPrefill}
            msgStructMatchCounts={msgStructMatchCounts}
          />
        )}

        {/* ── APP-LEVEL VIEW ──────────────────────────────────────────────── */}
        {!selectedApp && (
          <>
            {/* Application zones grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
              {applications.map((app) => (
                <AppZone
                  key={app.id}
                  group={app}
                  onFiles={(files) => handleAppFiles(app.id, files)}
                  onRemoveFile={(filename) => handleRemoveAppFile(app.id, filename)}
                  onClearApp={() => handleClearApp(app.id)}
                  onRename={(name) => handleRenameApp(app.id, name)}
                  onRemoveApp={() => handleRemoveApp(app.id)}
                  canRemoveApp={applications.length > 1}
                  analyzing={analyzingApps.has(app.id)}
                />
              ))}
              {/* Add application button */}
              <button
                className="flex flex-col items-center justify-center border-2 border-dashed border-gray-700 hover:border-gray-500 rounded-lg p-8 text-gray-600 hover:text-gray-400 transition-colors"
                onClick={handleAddApp}
              >
                <span className="text-2xl mb-1">+</span>
                <span className="text-xs font-mono">Add Application</span>
              </button>
            </div>

            {/* External headers zone */}
            <div className="mb-6">
              <div className="text-xs font-semibold uppercase tracking-wider text-gray-600 mb-2">
                External Headers <span className="font-normal normal-case text-gray-700">(shared across all applications)</span>
              </div>
              <div>
                <DropZone
                  zone="external"
                  onFiles={handleExternalFiles}
                  label="EXTERNAL INCLUDES"
                  accept=".h"
                  description="Drop shared include directory files here (.h only)"
                  allowDirectory
                />
                {externalFiles.length > 0 && (
                  <div className="flex justify-end mt-1.5">
                    <button
                      className="text-xs text-gray-600 hover:text-red-400 transition-colors"
                      onClick={handleClearExternal}
                    >
                      Clear all ({externalFiles.length})
                    </button>
                  </div>
                )}
                <FileList
                  entries={externalEntries}
                  zone="external"
                  onRemove={(filename) => handleRemoveExternal(filename)}
                />
              </div>
            </div>

            {/* Analyzing indicator */}
            {anyAnalyzing && (
              <div className="mb-4 text-xs text-gray-500 animate-pulse">
                Analyzing {[...analyzingApps].map((id) => applications.find((a) => a.id === id)?.name ?? id).join(', ')}…
              </div>
            )}

            {/* Application-level graph */}
            {(hasAnyAnalysis || applications.some((a) => a.files.length > 0)) && (
              <div className="mb-6">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400">
                    Application Interface Map
                  </h2>
                  <span className="text-xs text-gray-600">click an application node to inspect its internals</span>
                </div>
                <ApplicationGraph
                  groups={applications}
                  onDrillDown={(appId) => {
                    setSelectedAppId(appId);
                    setActiveFile(null);
                    setView('interfaces');
                    window.scrollTo({ top: 0, behavior: 'instant' });
                  }}
                />
              </div>
            )}

            {/* Cross-app interfaces summary */}
            {hasAnyAnalysis && (
              <CrossAppSummary applications={applications} />
            )}

            {/* Custom patterns */}
            <div className="mt-8 border-t border-gray-800 pt-6">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400">
                  Custom Patterns
                </h2>
                <ConfigButtons onExport={handleExportConfig} onImport={handleImportConfig} />
              </div>
              <div className="space-y-2">
                <PatternRegistryUI
                  patterns={patterns}
                  onAdd={handleAddPattern}
                  onUpdate={handleUpdatePattern}
                  onRemove={handleRemovePattern}
                  onImport={handleImportPatterns}
                  onExport={handleExportPatterns}
                  onReanalyze={handleReanalyze}
                  matchCounts={matchCounts}
                  prefill={patternPrefill}
                />
                <MsgStructPatternsUI
                  patterns={msgStructPatterns}
                  onAdd={handleAddMsgStructPattern}
                  onRemove={handleRemoveMsgStructPattern}
                  onImport={handleImportMsgStructPatterns}
                  onExport={handleExportMsgStructPatterns}
                  onReanalyze={handleReanalyze}
                  onDetect={handleDetectMsgStructs}
                  prefill={msgStructPrefill}
                  matchCounts={msgStructMatchCounts}
                />
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

// ── Cross-app summary ─────────────────────────────────────────────────────────

interface CrossAppEntry {
  constant: string;
  value: string;
  appRoles: { appId: string; appName: string; role: 'producer' | 'consumer' | 'both'; usedIn: import('./analyzer/types').FileRef[] }[];
  crossesApps: boolean; // true if both produced and consumed by different apps
}

function CrossAppSummary({ applications }: { applications: ApplicationGroup[] }) {
  const analyzed = applications.filter((a) => a.analysis !== null);
  const [query, setQuery] = useState('');
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());

  if (analyzed.length === 0) return null;

  const totalInterfaces = analyzed.reduce((s, a) => s + (a.analysis?.messageInterfaces.length ?? 0), 0);
  const totalFiles = analyzed.reduce((s, a) => s + (a.analysis?.files.length ?? 0), 0);

  // Build full cross-app index: constant → per-app role + file refs
  const indexMap = new Map<string, CrossAppEntry>();
  for (const app of analyzed) {
    for (const msg of app.analysis!.messageInterfaces) {
      if (!indexMap.has(msg.msgTypeConstant)) {
        indexMap.set(msg.msgTypeConstant, { constant: msg.msgTypeConstant, value: msg.msgTypeValue, appRoles: [], crossesApps: false });
      }
      const entry = indexMap.get(msg.msgTypeConstant)!;
      const produces = msg.fileRoles.some((r) => r.role === 'producer' || r.role === 'both');
      const consumes = msg.fileRoles.some((r) => r.role === 'consumer' || r.role === 'both');
      const role: 'producer' | 'consumer' | 'both' = produces && consumes ? 'both' : produces ? 'producer' : 'consumer';
      if (!entry.appRoles.find((r) => r.appId === app.id)) {
        entry.appRoles.push({ appId: app.id, appName: app.name, role, usedIn: msg.usedIn });
      }
    }
  }
  // Mark which constants cross app boundaries
  for (const entry of indexMap.values()) {
    const producers = entry.appRoles.filter((r) => r.role === 'producer' || r.role === 'both').map((r) => r.appId);
    const consumers = entry.appRoles.filter((r) => r.role === 'consumer' || r.role === 'both').map((r) => r.appId);
    entry.crossesApps = producers.length > 0 && consumers.length > 0 && !producers.every((p) => consumers.includes(p));
  }

  const q = query.trim().toLowerCase();
  const allEntries = [...indexMap.values()].sort((a, b) => a.constant.localeCompare(b.constant));
  const filtered = q ? allEntries.filter((e) => e.constant.toLowerCase().includes(q) || e.value.toLowerCase().includes(q)) : allEntries;
  const autoExpand = filtered.length === 1;

  function toggleRow(constant: string) {
    setOpenRows((prev) => {
      const next = new Set(prev);
      next.has(constant) ? next.delete(constant) : next.add(constant);
      return next;
    });
  }

  return (
    <div className="mb-8 border border-gray-800 rounded-lg overflow-hidden">
      <div className="px-4 py-3 bg-gray-900/60 border-b border-gray-800 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-300">Cross-Application Interfaces</h2>
          <p className="text-xs text-gray-600 mt-0.5">
            {analyzed.length} application{analyzed.length !== 1 ? 's' : ''} · {totalFiles} source files · {totalInterfaces} message interfaces
          </p>
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search message constants…"
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs font-mono text-gray-300 placeholder-gray-600 focus:outline-none focus:border-gray-500 w-52 shrink-0"
        />
      </div>

      {filtered.length > 0 ? (
        <div className="px-4 py-2">
          {filtered.map((entry) => {
            const isOpen = autoExpand || openRows.has(entry.constant);
            return (
              <div key={entry.constant} className="border-b border-gray-800/40 last:border-0">
                <button
                  className="w-full flex items-center gap-3 text-xs py-1.5 text-left hover:bg-gray-800/30 transition-colors"
                  onClick={() => toggleRow(entry.constant)}
                >
                  <span className="text-gray-700 w-3 shrink-0">{isOpen ? '▼' : '▶'}</span>
                  <span className="font-mono text-gray-200 w-56 shrink-0 truncate">{entry.constant}</span>
                  <span className="font-mono text-gray-600 w-14 shrink-0">{entry.value}</span>
                  {entry.crossesApps && (
                    <span className="px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-400 text-[10px] shrink-0">cross-app</span>
                  )}
                  <span className="text-gray-600 ml-auto shrink-0">
                    {entry.appRoles.length} app{entry.appRoles.length !== 1 ? 's' : ''}
                  </span>
                </button>
                {isOpen && (
                  <div className="pl-4 pb-2 space-y-1.5">
                    {entry.appRoles.map((ar) => (
                      <div key={ar.appId} className="pl-2 border-l border-gray-700/50">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="text-gray-400 font-semibold">{ar.appName}</span>
                          <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                            ar.role === 'producer' ? 'bg-blue-900/50 text-blue-300' :
                            ar.role === 'consumer' ? 'bg-green-900/50 text-green-300' :
                            'bg-purple-900/50 text-purple-300'
                          }`}>{ar.role}</span>
                        </div>
                        {ar.usedIn.length > 0 && (
                          <div className="mt-1 space-y-1">
                            {ar.usedIn.map((ref) => (
                              <div key={ref.filename}>
                                <div className="text-[10px] font-mono text-gray-600">{ref.filename}</div>
                                {ref.lines.map((l) => (
                                  <div key={l.lineNumber} className="flex gap-2 font-mono text-[10px] leading-4 pl-2">
                                    <span className="text-gray-700 w-7 shrink-0 text-right select-none">{l.lineNumber}</span>
                                    <span className="text-gray-500 truncate">{l.text}</span>
                                  </div>
                                ))}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : query ? (
        <div className="px-4 py-4 text-xs text-gray-600 italic">No message constants match "{query}"</div>
      ) : (
        <div className="px-4 py-4 text-xs text-gray-600">
          No cross-application message flows detected yet. Add source files to multiple applications to see connections.
        </div>
      )}
    </div>
  );
}

// ── Drill-down view ───────────────────────────────────────────────────────────

// ── Config export/import buttons ──────────────────────────────────────────────

function ConfigButtons({ onExport, onImport }: { onExport: () => void; onImport: (json: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => onImport(ev.target?.result as string);
    reader.readAsText(file);
    e.target.value = '';
  }

  return (
    <div className="flex gap-2">
      <button
        className="px-2.5 py-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 rounded transition-colors"
        onClick={onExport}
        title="Export all custom patterns and struct patterns as a single config file"
      >
        ↓ Export Config
      </button>
      <button
        className="px-2.5 py-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 rounded transition-colors"
        onClick={() => ref.current?.click()}
        title="Import config file (restores custom patterns and struct patterns)"
      >
        ↑ Import Config
      </button>
      <input ref={ref} type="file" accept=".json" className="hidden" onChange={handleFile} />
    </div>
  );
}

// ── Drill-down view ───────────────────────────────────────────────────────────

interface DrillDownViewProps {
  app: ApplicationGroup;
  analysis: StringAnalysis | null;
  analyzing: boolean;
  activeFile: string | null;
  setActiveFile: (f: string) => void;
  activeFileAnalysis: FileAnalysis | null;
  activeFileStructs: import('./analyzer/types').CStruct[];
  view: 'interfaces' | 'per-file';
  setView: (v: 'interfaces' | 'per-file') => void;
  sourceFiles: LoadedFile[];
  onAddAsPattern: (fn: string) => void;
  onAddAsMsgStructPattern: (name: string) => void;
  patterns: CustomPattern[];
  onAddPattern: (p: Omit<CustomPattern, 'id'>) => void;
  onUpdatePattern: (id: string, changes: Partial<Omit<CustomPattern, 'id'>>) => void;
  onRemovePattern: (id: string) => void;
  onImportPatterns: (imported: CustomPattern[]) => void;
  onExportPatterns: () => void;
  onReanalyze: () => void;
  matchCounts: Map<string, number>;
  patternPrefill: string | undefined;
  msgStructPatterns: MsgStructPattern[];
  onAddMsgStructPattern: (p: Omit<MsgStructPattern, 'id'>) => void;
  onRemoveMsgStructPattern: (id: string) => void;
  onImportMsgStructPatterns: (imported: MsgStructPattern[]) => void;
  onExportMsgStructPatterns: () => void;
  onExportConfig: () => void;
  onImportConfig: (json: string) => void;
  onDetectMsgStructs: () => number;
  msgStructPrefill: string | undefined;
  msgStructMatchCounts: Map<string, number>;
}

function DrillDownView({
  app,
  analysis,
  analyzing,
  activeFile,
  setActiveFile,
  activeFileAnalysis,
  activeFileStructs,
  view,
  setView,
  sourceFiles,
  onAddAsPattern,
  onAddAsMsgStructPattern,
  patterns,
  onAddPattern,
  onUpdatePattern,
  onRemovePattern,
  onImportPatterns,
  onExportPatterns,
  onReanalyze,
  matchCounts,
  patternPrefill,
  msgStructPatterns,
  onAddMsgStructPattern,
  onRemoveMsgStructPattern,
  onImportMsgStructPatterns,
  onExportMsgStructPatterns,
  onExportConfig,
  onImportConfig,
  onDetectMsgStructs,
  msgStructPrefill,
  msgStructMatchCounts,
}: DrillDownViewProps) {
  const allWarnings = analysis?.warnings ?? [];

  return (
    <>
      {analyzing && (
        <div className="mb-4 text-xs text-gray-500 animate-pulse">Analyzing {app.name}…</div>
      )}

      {!analysis && !analyzing && app.files.length === 0 && (
        <div className="mb-6 p-4 border border-gray-800 rounded-lg text-sm text-gray-600">
          No source files loaded for {app.name}. Go back and add files to this application.
        </div>
      )}

      {analysis && (
        <>
          <WarningBanner warnings={allWarnings} />
          <SummaryBar analysis={analysis} />

          {/* Graph */}
          <div className="mb-6">
            <InterfaceGraph
              analysis={analysis}
              onSelectFile={(filename) => setActiveFile(filename)}
            />
          </div>

          {/* View tabs */}
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

          {view === 'interfaces' && (
            <ExternalInterfacesSummary analysis={analysis} sourceFiles={sourceFiles} />
          )}

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
                    sourceFiles={sourceFiles}
                    onAddAsMsgStructPattern={onAddAsMsgStructPattern}
                  />
                  <ExternsSection externs={activeFileAnalysis.externs} />
                  <DefinesSection defines={activeFileAnalysis.defines} />
                  <UnknownsSection
                    unknownCalls={activeFileAnalysis.unknownCalls}
                    onAddAsPattern={onAddAsPattern}
                  />
                  <RiskSection risks={activeFileAnalysis.risks} />
                </div>
              )}
            </div>
          )}

          {/* Custom patterns */}
          <div className="mt-8 border-t border-gray-800 pt-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400">
                Custom Patterns
              </h2>
              <ConfigButtons onExport={onExportConfig} onImport={onImportConfig} />
            </div>
            <div className="space-y-2">
              <PatternRegistryUI
                patterns={patterns}
                onAdd={onAddPattern}
                onUpdate={onUpdatePattern}
                onRemove={onRemovePattern}
                onImport={onImportPatterns}
                onExport={onExportPatterns}
                onReanalyze={onReanalyze}
                matchCounts={matchCounts}
                prefill={patternPrefill}
              />
              <MsgStructPatternsUI
                patterns={msgStructPatterns}
                onAdd={onAddMsgStructPattern}
                onRemove={onRemoveMsgStructPattern}
                onImport={onImportMsgStructPatterns}
                onExport={onExportMsgStructPatterns}
                onReanalyze={onReanalyze}
                onDetect={onDetectMsgStructs}
                prefill={msgStructPrefill}
                matchCounts={msgStructMatchCounts}
              />
            </div>
          </div>
        </>
      )}
    </>
  );
}
