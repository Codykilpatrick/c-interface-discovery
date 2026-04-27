import { useState } from 'react';
import type { ApplicationGroup } from '../analyzer/types';
import type { CStructLayout, StructCatalog } from '../analyzer/structLayoutEngine';
import type { PayloadResolution } from '../analyzer/payloadResolver';

interface InterfaceModeViewProps {
  applications: ApplicationGroup[];
}

type Tab = 'catalog' | 'pivot' | 'interface-sites';

export default function InterfaceModeView({ applications }: InterfaceModeViewProps) {
  const [tab, setTab] = useState<Tab>('catalog');

  // Merge struct catalogs from all apps, deduplicating by struct name (first wins)
  const mergedCatalog = mergeCatalogs(applications);
  const allMsgInterfaces = applications.flatMap((a) => a.analysis?.messageInterfaces ?? []);
  const allPayloadResolutions = applications.flatMap((a) => a.analysis?.payloadResolutions ?? []);

  if (mergedCatalog.layouts.length === 0 && allMsgInterfaces.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="text-3xl mb-4 text-gray-700">🔬</div>
        <h2 className="text-lg font-semibold text-gray-400 mb-2">Interface Mode</h2>
        <p className="text-sm text-gray-600 max-w-sm">
          Load source and header files in IPC mode first — Interface Mode shows struct layouts and
          interface site analysis after a successful analysis run.
        </p>
      </div>
    );
  }

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'catalog', label: 'Struct Catalog', count: mergedCatalog.layouts.length },
    { id: 'pivot', label: 'Struct Pivot', count: allMsgInterfaces.filter((m) => m.struct).length },
    { id: 'interface-sites', label: 'Interface Sites', count: allPayloadResolutions.length },
  ];

  return (
    <div className="space-y-4">
      {/* Target info */}
      {applications.some((a) => a.analysis?.layoutTarget) && (
        <div className="text-xs text-gray-600 flex gap-4">
          <span>Layout target: <span className="text-gray-400 font-mono">
            {applications.find((a) => a.analysis?.layoutTarget)?.analysis?.layoutTarget ?? '64bit'}
          </span></span>
          <span>Structs: <span className="text-gray-400">{mergedCatalog.layouts.length}</span></span>
        </div>
      )}

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-gray-800">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
              tab === t.id
                ? 'border-blue-500 text-blue-300'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.count !== undefined && (
              <span className="ml-1.5 text-gray-600">{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'catalog' && <CatalogTab catalog={mergedCatalog} />}
      {tab === 'pivot' && <StructPivotTab applications={applications} catalog={mergedCatalog} />}
      {tab === 'interface-sites' && <InterfaceSitesTab resolutions={allPayloadResolutions} />}
    </div>
  );
}

// ── Catalog tab ───────────────────────────────────────────────────────────────

function CatalogTab({ catalog }: { catalog: StructCatalog }) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const q = query.trim().toLowerCase();
  const filtered = q
    ? catalog.layouts.filter((l) => l.name.toLowerCase().includes(q))
    : catalog.layouts;
  const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name));

  function toggle(name: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }

  if (catalog.layouts.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-gray-600">
        No structs found. Load header files (.h) containing struct definitions.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Search */}
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search struct names…"
        className="w-full max-w-sm bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm font-mono text-gray-300 placeholder-gray-600 focus:outline-none focus:border-gray-500"
      />

      {/* Struct list */}
      <div className="space-y-1">
        {sorted.length === 0 ? (
          <div className="py-4 text-sm text-gray-600 italic">No structs match "{query}"</div>
        ) : (
          sorted.map((layout) => (
            <StructCard
              key={layout.name}
              layout={layout}
              expanded={expanded.has(layout.name)}
              onToggle={() => toggle(layout.name)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function StructCard({ layout, expanded, onToggle }: { layout: CStructLayout; expanded: boolean; onToggle: () => void }) {
  const paddingPct = layout.totalSizeBytes > 0
    ? Math.round((layout.paddingBytes / layout.totalSizeBytes) * 100)
    : 0;

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-800/40 transition-colors"
        onClick={onToggle}
      >
        <span className="text-gray-600 w-3 shrink-0 text-xs">{expanded ? '▼' : '▶'}</span>
        <span className="font-mono text-sm text-gray-200 flex-1 truncate">{layout.name}</span>
        {layout.isEstimated && (
          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-400">~estimated</span>
        )}
        <div className="shrink-0 flex items-center gap-4 text-xs text-gray-500">
          <span><span className="text-gray-300 font-mono">{layout.totalSizeBytes}</span> B</span>
          <span>align <span className="text-gray-300 font-mono">{layout.alignBytes}</span></span>
          {paddingPct > 0 && (
            <span className={`${paddingPct >= 20 ? 'text-amber-600' : 'text-gray-600'}`}>
              {paddingPct}% pad
            </span>
          )}
          <span className="text-gray-700">{layout.fields.length} fields</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-gray-800 overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="bg-gray-900/60">
                <th className="px-3 py-1.5 text-left text-gray-600 font-medium">Field</th>
                <th className="px-3 py-1.5 text-left text-gray-600 font-medium">Type</th>
                <th className="px-3 py-1.5 text-right text-gray-600 font-medium">Offset</th>
                <th className="px-3 py-1.5 text-right text-gray-600 font-medium">Size</th>
                <th className="px-3 py-1.5 text-right text-gray-600 font-medium">Align</th>
                <th className="px-3 py-1.5 text-left text-gray-600 font-medium">Flags</th>
              </tr>
            </thead>
            <tbody>
              {layout.fields.map((field, i) => (
                <tr key={i} className="border-t border-gray-800/40 hover:bg-gray-800/20">
                  <td className="px-3 py-1 text-gray-200">{field.name}</td>
                  <td className="px-3 py-1 text-gray-500 max-w-[160px] truncate" title={field.type}>{field.type}</td>
                  <td className="px-3 py-1 text-right text-blue-400">+{field.offsetBytes}</td>
                  <td className="px-3 py-1 text-right text-gray-300">{field.sizeBytes}</td>
                  <td className="px-3 py-1 text-right text-gray-600">{field.alignBytes}</td>
                  <td className="px-3 py-1 text-gray-600 space-x-1">
                    {field.isPointer && <span className="text-purple-500">ptr</span>}
                    {field.isArray && <span className="text-green-600">[{field.arrayLength ?? '?'}]</span>}
                    {field.bitWidth !== undefined && <span className="text-amber-600">:{field.bitWidth}</span>}
                  </td>
                </tr>
              ))}
              {/* Tail padding row */}
              {layout.paddingBytes > 0 && (
                <tr className="border-t border-gray-800/40 opacity-40">
                  <td className="px-3 py-1 text-gray-600 italic">(padding)</td>
                  <td className="px-3 py-1 text-gray-700">—</td>
                  <td className="px-3 py-1 text-right text-gray-700">
                    +{layout.totalSizeBytes - layout.paddingBytes}
                  </td>
                  <td className="px-3 py-1 text-right text-gray-700">{layout.paddingBytes}</td>
                  <td colSpan={2}></td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="px-3 py-1.5 bg-gray-900/40 border-t border-gray-800 flex gap-6 text-xs text-gray-600">
            <span>Total: <span className="text-gray-400">{layout.totalSizeBytes} bytes</span></span>
            <span>Padding: <span className={layout.paddingBytes > 0 ? 'text-amber-600' : 'text-gray-400'}>{layout.paddingBytes} bytes ({paddingPct}%)</span></span>
            <span>Source: <span className="text-gray-500 font-mono">{layout.sourceFile}</span></span>
            {layout.packAttribute !== undefined && (
              <span>Pack: <span className="text-gray-400">{layout.packAttribute}</span></span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Struct Pivot tab ──────────────────────────────────────────────────────────

function StructPivotTab({ applications, catalog }: { applications: ApplicationGroup[]; catalog: StructCatalog }) {
  const [query, setQuery] = useState('');

  const allMsgInterfaces = applications.flatMap((a) =>
    (a.analysis?.messageInterfaces ?? []).map((m) => ({ ...m, appName: a.name }))
  );

  // Group message interfaces by their resolved struct name
  const byStruct = new Map<string, typeof allMsgInterfaces>();
  for (const msg of allMsgInterfaces) {
    if (!msg.struct) continue;
    const name = msg.struct.name;
    if (!byStruct.has(name)) byStruct.set(name, []);
    byStruct.get(name)!.push(msg);
  }

  const q = query.trim().toLowerCase();
  const entries = [...byStruct.entries()]
    .filter(([name]) => !q || name.toLowerCase().includes(q))
    .sort(([a], [b]) => a.localeCompare(b));

  if (byStruct.size === 0) {
    return (
      <div className="py-8 text-center text-sm text-gray-600">
        No message interfaces have resolved struct types. Load source files and define message struct patterns
        (or use "Detect Message Structs" in IPC mode).
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search struct names…"
        className="w-full max-w-sm bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm font-mono text-gray-300 placeholder-gray-600 focus:outline-none focus:border-gray-500"
      />

      {entries.length === 0 ? (
        <div className="py-4 text-sm text-gray-600 italic">No structs match "{query}"</div>
      ) : (
        <div className="space-y-4">
          {entries.map(([structName, msgs]) => {
            const layout = catalog.layouts.find((l) => l.name === structName);
            return (
              <div key={structName} className="border border-gray-800 rounded-lg overflow-hidden">
                <div className="px-4 py-2.5 bg-gray-900/60 border-b border-gray-800 flex items-center gap-3">
                  <span className="font-mono text-sm text-gray-200">{structName}</span>
                  {layout && (
                    <span className="text-xs text-gray-600">
                      {layout.totalSizeBytes} B · {layout.fields.length} fields
                    </span>
                  )}
                  <span className="ml-auto text-xs text-gray-600">{msgs.length} message{msgs.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="divide-y divide-gray-800/40">
                  {msgs.map((msg, i) => (
                    <div key={i} className="px-4 py-2 flex items-center gap-3 text-xs">
                      <span className="font-mono text-gray-300 flex-1 truncate">{msg.msgTypeConstant}</span>
                      <span className="text-gray-600 font-mono">{msg.msgTypeValue}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                        msg.direction === 'producer' ? 'bg-blue-900/50 text-blue-300' :
                        msg.direction === 'consumer' ? 'bg-green-900/50 text-green-300' :
                        'bg-purple-900/50 text-purple-300'
                      }`}>{msg.direction}</span>
                      <span className="text-gray-600 shrink-0">{msg.appName}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Interface Sites tab ───────────────────────────────────────────────────────

const CONFIDENCE_COLOR: Record<string, string> = {
  high:       'text-green-400 bg-green-900/30',
  medium:     'text-yellow-400 bg-yellow-900/30',
  low:        'text-orange-400 bg-orange-900/30',
  unresolved: 'text-red-400 bg-red-900/30',
};

const STRATEGY_LABEL: Record<string, string> = {
  'address-of':        '&var',
  'pointer':           'ptr param',
  'cast':              'cast',
  'memcpy':            'memcpy',
  'msg-id-correlation':'msg-ID',
  'callback':          'callback fn',
  'unresolved':        '?',
};

function exportInterfaceSites(resolutions: PayloadResolution[]) {
  const rows = [
    ['File', 'Line', 'Pattern', 'Struct', 'Confidence', 'Strategy', 'Call Site'].join('\t'),
    ...resolutions.map((r) => [
      r.sendSiteFile,
      String(r.sendSiteLine),
      r.patternName,
      r.resolvedStructName ?? '',
      r.confidence,
      r.strategy,
      r.sendSiteText.replace(/\t/g, ' '),
    ].join('\t')),
  ].join('\n');
  const blob = new Blob([rows], { type: 'text/tab-separated-values' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'cid-interface-sites.tsv';
  a.click();
  URL.revokeObjectURL(url);
}

function InterfaceSitesTab({ resolutions }: { resolutions: PayloadResolution[] }) {
  const [query, setQuery] = useState('');

  if (resolutions.length === 0) {
    return (
      <div className="py-12 text-center">
        <div className="text-2xl mb-3 text-gray-700">📡</div>
        <h3 className="text-sm font-semibold text-gray-500 mb-1">No Interface Sites Yet</h3>
        <p className="text-xs text-gray-600 max-w-sm mx-auto">
          Register IPC API patterns with a <span className="font-mono text-gray-500">payload arg index</span> in
          Custom Patterns to enable interface site analysis. Each matching call (send or receive) will
          appear here with its resolved struct type and confidence level.
        </p>
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const filtered = q
    ? resolutions.filter(
        (r) => r.sendSiteFile.toLowerCase().includes(q) ||
               r.patternName.toLowerCase().includes(q) ||
               (r.resolvedStructName ?? '').toLowerCase().includes(q)
      )
    : resolutions;

  const byFile = new Map<string, PayloadResolution[]>();
  for (const r of filtered) {
    if (!byFile.has(r.sendSiteFile)) byFile.set(r.sendSiteFile, []);
    byFile.get(r.sendSiteFile)!.push(r);
  }

  const stats = {
    high: resolutions.filter((r) => r.confidence === 'high').length,
    medium: resolutions.filter((r) => r.confidence === 'medium').length,
    low: resolutions.filter((r) => r.confidence === 'low').length,
    unresolved: resolutions.filter((r) => r.confidence === 'unresolved').length,
  };

  return (
    <div className="space-y-3">
      {/* Stats + export bar */}
      <div className="flex items-center gap-4">
        <div className="flex gap-4 text-xs flex-1">
          <span className="text-green-400">{stats.high} high</span>
          <span className="text-yellow-400">{stats.medium} medium</span>
          <span className="text-orange-400">{stats.low} low</span>
          <span className="text-red-400">{stats.unresolved} unresolved</span>
        </div>
        <button
          className="shrink-0 px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 rounded transition-colors"
          onClick={() => exportInterfaceSites(resolutions)}
        >
          ↓ Export TSV
        </button>
      </div>

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filter by file, pattern, or struct…"
        className="w-full max-w-sm bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm font-mono text-gray-300 placeholder-gray-600 focus:outline-none focus:border-gray-500"
      />

      {byFile.size === 0 ? (
        <div className="py-4 text-sm text-gray-600 italic">No results match "{query}"</div>
      ) : (
        <div className="space-y-4">
          {[...byFile.entries()].map(([filename, fileResolutions]) => (
            <div key={filename} className="border border-gray-800 rounded-lg overflow-hidden">
              <div className="px-4 py-2 bg-gray-900/60 border-b border-gray-800 flex items-center gap-2">
                <span className="font-mono text-xs text-gray-400">{filename}</span>
                <span className="ml-auto text-xs text-gray-600">{fileResolutions.length} site{fileResolutions.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="divide-y divide-gray-800/40">
                {fileResolutions.map((r, i) => (
                  <div key={i} className="px-4 py-2 space-y-1">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-gray-600 font-mono w-12 shrink-0">:{r.sendSiteLine}</span>
                      <span className="text-gray-400 font-mono">{r.patternName}</span>
                      <span className={`ml-auto shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${CONFIDENCE_COLOR[r.confidence]}`}>
                        {r.confidence}
                      </span>
                      <span className="shrink-0 text-[10px] text-gray-600 font-mono">{STRATEGY_LABEL[r.strategy]}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs pl-14">
                      {r.resolvedStructName ? (
                        <span className="font-mono text-blue-300">{r.resolvedStructName}</span>
                      ) : (
                        <span className="text-gray-600 italic">struct unresolved</span>
                      )}
                      {r.notes && <span className="text-gray-600">— {r.notes}</span>}
                    </div>
                    <div className="pl-14 font-mono text-[10px] text-gray-600 truncate">{r.sendSiteText}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mergeCatalogs(applications: ApplicationGroup[]): StructCatalog {
  const seen = new Set<string>();
  const layouts: CStructLayout[] = [];
  const typedefMap = new Map<string, string>();

  for (const app of applications) {
    const catalog = app.analysis?.structCatalog;
    if (!catalog) continue;
    for (const layout of catalog.layouts) {
      if (!seen.has(layout.name)) {
        seen.add(layout.name);
        layouts.push(layout);
      }
    }
    for (const [alias, canonical] of catalog.typedefMap) {
      if (!typedefMap.has(alias)) typedefMap.set(alias, canonical);
    }
  }

  return { layouts, typedefMap };
}
