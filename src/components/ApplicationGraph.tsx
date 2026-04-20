import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type NodeProps,
  type EdgeProps,
  type NodeTypes,
  type EdgeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMemo, useState, useEffect, useContext, createContext } from 'react';
import { useNodesState } from '@xyflow/react';
import type { IpcType, MessageInterface } from '../analyzer/types';
import {
  buildAppGraph,
  APP_EXTERNAL_NODE_ID,
  type AppNode,
  type AppNodeData,
  type AppExternalNode,
  type AppExternalNodeData,
  type CrossAppEdge,
  type CrossAppEdgeData,
} from '../utils/buildAppGraph';
import type { EdgeDirection, RankDir } from '../utils/buildGraph';

// ── Selection context ─────────────────────────────────────────────────────────

interface GraphSelection {
  selectedNodeId: string | null;
  connectedEdgeIds: Set<string>;
  connectedNodeIds: Set<string>;
}
const SelectionCtx = createContext<GraphSelection>({
  selectedNodeId: null,
  connectedEdgeIds: new Set(),
  connectedNodeIds: new Set(),
});

// ── IPC color map ─────────────────────────────────────────────────────────────

const IPC_COLOR: Partial<Record<IpcType, string>> = {
  'socket':       '#60a5fa',
  'socket-send':  '#60a5fa',
  'socket-recv':  '#60a5fa',
  'shared-mem':   '#c084fc',
  'pipe':         '#facc15',
  'fifo':         '#facc15',
  'mqueue':       '#fb923c',
  'semaphore':    '#f472b6',
  'signal':       '#f87171',
  'thread':       '#22d3ee',
  'process-fork': '#4ade80',
  'process-exec': '#4ade80',
  'file-io':      '#9ca3af',
  'ioctl':        '#9ca3af',
  'custom':       '#2dd4bf',
};

function ipcColor(t: IpcType | null | undefined): string {
  return (t && IPC_COLOR[t]) ?? '#4b5563';
}

const DIRECTION_COLOR: Record<EdgeDirection, string> = {
  unidirectional: '#60a5fa',
  bidirectional:  '#a78bfa',
  uncertain:      '#fbbf24',
};

// ── App node ──────────────────────────────────────────────────────────────────

function AppNodeComponent({ data, selected, id }: NodeProps<AppNode>) {
  const { label, ipcTypes, fileCount } = data as AppNodeData;
  const { selectedNodeId, connectedNodeIds } = useContext(SelectionCtx);
  const isSelected = id === selectedNodeId;
  const isDimmed = selectedNodeId !== null && !isSelected && !connectedNodeIds.has(id);

  return (
    <div
      className="bg-gray-900 rounded-lg px-3 py-2.5 w-48 shadow-lg transition-all cursor-pointer group"
      style={{
        border: `2px solid ${isSelected || selected ? '#60a5fa' : '#374151'}`,
        opacity: isDimmed ? 0.25 : 1,
      }}
      onMouseEnter={(e) => { if (!isSelected && !selected) (e.currentTarget as HTMLDivElement).style.borderColor = '#6b7280'; }}
      onMouseLeave={(e) => { if (!isSelected && !selected) (e.currentTarget as HTMLDivElement).style.borderColor = '#374151'; }}
    >
      <Handle type="target" position={Position.Left}  style={{ background: '#4b5563' }} />
      <Handle type="source" position={Position.Right} style={{ background: '#4b5563' }} />

      <div className="font-semibold text-sm text-gray-100 truncate mb-1">{label}</div>

      {fileCount > 0 && (
        <div className="text-xs text-gray-600 mb-1">{fileCount} source file{fileCount !== 1 ? 's' : ''}</div>
      )}

      {(ipcTypes as IpcType[]).length > 0 && (
        <div className="flex flex-wrap gap-1">
          {(ipcTypes as IpcType[]).map((t) => (
            <span
              key={t}
              style={{ color: ipcColor(t), borderColor: ipcColor(t) }}
              className="text-[10px] font-mono border rounded px-1 opacity-70"
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── External phantom node ─────────────────────────────────────────────────────

function AppExternalNodeComponent({ selected, id, data }: NodeProps<AppExternalNode>) {
  const { selectedNodeId, connectedNodeIds } = useContext(SelectionCtx);
  const isSelected = id === selectedNodeId;
  const isDimmed = selectedNodeId !== null && !isSelected && !connectedNodeIds.has(id);
  return (
    <div
      className="rounded-lg px-3 py-2 w-36 flex flex-col items-center justify-center"
      style={{
        border: `2px dashed ${selected || isSelected ? '#94a3b8' : '#4b5563'}`,
        background: 'rgba(17,24,39,0.7)',
        opacity: isDimmed ? 0.25 : 1,
      }}
    >
      <Handle type="target" position={Position.Left}  style={{ background: '#374151' }} />
      <Handle type="source" position={Position.Right} style={{ background: '#374151' }} />
      <div className="text-2xl text-gray-600 leading-none mb-1">?</div>
      <div className="text-xs text-gray-500 font-mono">{(data as AppExternalNodeData).label}</div>
    </div>
  );
}

// ── Cross-app edge ────────────────────────────────────────────────────────────

interface EdgeClickHandler {
  onEdgeClick: (edgeId: string, data: CrossAppEdgeData, sourceLabel: string, targetLabel: string) => void;
  nodeLabels: Map<string, string>;
}
const EdgeClickCtx = createContext<EdgeClickHandler>({
  onEdgeClick: () => {},
  nodeLabels: new Map(),
});

function CrossAppEdgeComponent({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, data, selected,
}: EdgeProps<CrossAppEdge>) {
  const [expanded, setExpanded] = useState(false);
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
    borderRadius: 8,
  });

  const { selectedNodeId, connectedEdgeIds } = useContext(SelectionCtx);
  const { onEdgeClick, nodeLabels } = useContext(EdgeClickCtx);

  const isHighlighted = selectedNodeId !== null && connectedEdgeIds.has(id);
  const isDimmed = selectedNodeId !== null && !connectedEdgeIds.has(id);

  const edgeData = data as CrossAppEdgeData | undefined;
  const direction = edgeData?.direction ?? 'uncertain';
  const color = selected || isHighlighted ? '#e2e8f0' : DIRECTION_COLOR[direction];
  const strokeDash = direction === 'uncertain' ? '6 3' : undefined;
  const markerId = `cid-app-arrow-${direction}`;

  function handleLabelClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (!edgeData) return;
    const [src, tgt] = id.split('→');
    onEdgeClick(id, edgeData, nodeLabels.get(src) ?? src, nodeLabels.get(tgt) ?? tgt);
  }

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: color,
          strokeWidth: selected || isHighlighted ? 2.5 : 1.5,
          strokeDasharray: strokeDash,
          opacity: isDimmed ? 0.08 : 0.85,
          transition: 'opacity 0.15s, stroke-width 0.15s',
        }}
        markerStart={direction === 'bidirectional' ? `url(#${markerId}-start)` : undefined}
        markerEnd={`url(#${markerId})`}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
            opacity: isDimmed ? 0.08 : 1,
            transition: 'opacity 0.15s',
          }}
          className="nodrag nopan"
        >
          {edgeData?.msgTypes && (
            <div
              role="button"
              style={{ borderColor: color, color }}
              className="bg-gray-950 border rounded px-1.5 py-0.5 text-[10px] font-mono max-w-36 text-center leading-tight cursor-pointer hover:brightness-125 transition-all select-none"
              onClick={(e) => {
                setExpanded((v) => !v);
                handleLabelClick(e);
              }}
              title="Click to view interface details"
            >
              {(expanded ? edgeData.msgTypes : edgeData.msgTypes.slice(0, 2)).map((m) => (
                <div key={m} className="truncate">
                  {m.replace(/^MSG_TYPE_|^MSG_ID_|^PKT_TYPE_|^OPCODE_/, '')}
                </div>
              ))}
              {!expanded && edgeData.msgTypes.length > 2 && (
                <div className="text-gray-500">+{edgeData.msgTypes.length - 2} more</div>
              )}
            </div>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes: NodeTypes = {
  appNode:         AppNodeComponent,
  appExternalNode: AppExternalNodeComponent,
};
const edgeTypes: EdgeTypes = { crossAppEdge: CrossAppEdgeComponent };

// ── Interface detail panel ────────────────────────────────────────────────────

function InterfaceDetailPanel({
  sourceLabel,
  targetLabel,
  interfaces,
  onClose,
}: {
  sourceLabel: string;
  targetLabel: string;
  interfaces: MessageInterface[];
  onClose: () => void;
}) {
  return (
    <div className="absolute right-0 top-0 h-full w-72 bg-gray-900 border-l border-gray-700 flex flex-col z-20 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-gray-700 shrink-0">
        <div>
          <div className="text-xs font-semibold text-gray-200">Interface Detail</div>
          <div className="text-[10px] text-gray-500 font-mono mt-0.5">
            {sourceLabel} → {targetLabel}
          </div>
        </div>
        <button className="text-gray-600 hover:text-gray-400 text-sm" onClick={onClose}>✕</button>
      </div>
      <div className="overflow-y-auto flex-1 px-3 py-2 space-y-2">
        {interfaces.map((msg) => (
          <div key={msg.msgTypeConstant} className="border border-gray-700/60 rounded p-2 text-xs">
            <div className="font-mono text-gray-100 font-semibold truncate">{msg.msgTypeConstant}</div>
            <div className="flex flex-wrap gap-1.5 mt-1 items-center">
              <span className="text-gray-600 font-mono">{msg.msgTypeValue}</span>
              <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                msg.direction === 'producer' ? 'bg-blue-900/50 text-blue-300' :
                msg.direction === 'consumer' ? 'bg-green-900/50 text-green-300' :
                msg.direction === 'both'     ? 'bg-purple-900/50 text-purple-300' :
                                               'bg-gray-800 text-gray-500'
              }`}>{msg.direction}</span>
              {!msg.directionConfident && (
                <span className="text-yellow-600 text-[10px]">uncertain</span>
              )}
              {msg.transport && (
                <span className="text-gray-600">via {msg.transport}</span>
              )}
            </div>
            {msg.struct && (
              <div className="mt-1 text-gray-500">
                struct <span className="text-cyan-600 font-mono">{msg.struct.name}</span>
                {msg.struct.fields.length > 0 && (
                  <span className="text-gray-700"> ({msg.struct.fields.length} fields)</span>
                )}
              </div>
            )}
            {!msg.struct && (
              <div className="mt-1 text-gray-700 italic">struct unresolved</div>
            )}
            <div className="mt-1 text-gray-700 font-mono text-[10px] truncate">
              defined in: {msg.definedIn}
            </div>
            {msg.fileRoles.length > 0 && (
              <div className="mt-1.5 space-y-0.5">
                {msg.fileRoles.map((r) => (
                  <div key={r.filename} className="flex items-center gap-1.5 text-[10px]">
                    <span className={`px-1 py-0.5 rounded ${
                      r.role === 'producer' ? 'bg-blue-900/40 text-blue-400' :
                      r.role === 'consumer' ? 'bg-green-900/40 text-green-400' :
                      'bg-purple-900/40 text-purple-400'
                    }`}>{r.role}</span>
                    <span className="font-mono text-gray-600 truncate">{r.filename}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface ApplicationGraphProps {
  groups: Array<{ id: string; name: string; analysis: import('../analyzer/types').StringAnalysis | null }>;
  onDrillDown: (appId: string) => void;
}

export default function ApplicationGraph({ groups, onDrillDown }: ApplicationGraphProps) {
  const [rankdir, setRankdir] = useState<RankDir>('LR');
  const { nodes: initialNodes, edges } = useMemo(() => buildAppGraph(groups, rankdir), [groups, rankdir]);
  const [nodes, setNodes, onNodesChange] = useNodesState<AppNode | AppExternalNode>(initialNodes);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [detailPanel, setDetailPanel] = useState<{
    edgeId: string;
    sourceLabel: string;
    targetLabel: string;
    interfaces: MessageInterface[];
  } | null>(null);

  useEffect(() => {
    setNodes(initialNodes);
    setSelectedNodeId(null);
    setDetailPanel(null);
  }, [initialNodes, setNodes]);

  const { connectedEdgeIds, connectedNodeIds } = useMemo(() => {
    if (!selectedNodeId) return { connectedEdgeIds: new Set<string>(), connectedNodeIds: new Set<string>() };
    const edgeIds = new Set<string>();
    const nodeIds = new Set<string>();
    for (const edge of edges) {
      if (edge.source === selectedNodeId || edge.target === selectedNodeId) {
        edgeIds.add(edge.id);
        nodeIds.add(edge.source === selectedNodeId ? edge.target : edge.source);
      }
    }
    return { connectedEdgeIds: edgeIds, connectedNodeIds: nodeIds };
  }, [selectedNodeId, edges]);

  const selectionCtx = useMemo<GraphSelection>(
    () => ({ selectedNodeId, connectedEdgeIds, connectedNodeIds }),
    [selectedNodeId, connectedEdgeIds, connectedNodeIds]
  );

  const nodeLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const node of nodes) {
      if (node.type === 'appNode') m.set(node.id, (node.data as AppNodeData).label);
    }
    return m;
  }, [nodes]);

  const edgeClickCtx = useMemo<EdgeClickHandler>(() => ({
    onEdgeClick: (_edgeId, data, sourceLabel, targetLabel) => {
      setDetailPanel({ edgeId: _edgeId, sourceLabel, targetLabel, interfaces: data.interfaces as MessageInterface[] });
    },
    nodeLabels,
  }), [nodeLabels]);

  if (nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-gray-600 text-sm">
        Add files to applications above to visualize cross-application interfaces
      </div>
    );
  }

  const analyzedCount = groups.filter((g) => g.analysis !== null).length;

  return (
    <div>
      {analyzedCount < groups.length && (
        <div className="mb-2 text-xs text-gray-600">
          {groups.length - analyzedCount} application{groups.length - analyzedCount !== 1 ? 's' : ''} not yet analyzed — add source files to see their connections
        </div>
      )}
      <SelectionCtx.Provider value={selectionCtx}>
        <EdgeClickCtx.Provider value={edgeClickCtx}>
          <div
            className="w-full rounded-lg overflow-hidden border border-gray-800 relative"
            style={{ height: Math.max(480, Math.min(700, nodes.length * 70 + 100)) }}
          >
            <ReactFlow
              nodes={nodes}
              onNodesChange={onNodesChange}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView
              fitViewOptions={{ padding: 0.25 }}
              minZoom={0.2}
              onNodeClick={(_, node) => {
                const nodeId = node.id;
                setSelectedNodeId((prev) => (prev === nodeId ? null : nodeId));
                if (nodeId !== APP_EXTERNAL_NODE_ID) {
                  onDrillDown(nodeId);
                }
              }}
              onPaneClick={() => { setSelectedNodeId(null); setDetailPanel(null); }}
              colorMode="dark"
              proOptions={{ hideAttribution: true }}
            >
              <svg style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
                <defs>
                  {(Object.entries(DIRECTION_COLOR) as [EdgeDirection, string][]).map(([dir, color]) => (
                    <g key={dir}>
                      <marker id={`cid-app-arrow-${dir}`} markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                        <polygon points="0 0, 8 3, 0 6" fill={color} />
                      </marker>
                      {dir === 'bidirectional' && (
                        <marker id={`cid-app-arrow-${dir}-start`} markerWidth="8" markerHeight="6" refX="1" refY="3" orient="auto-start-reverse">
                          <polygon points="0 0, 8 3, 0 6" fill={color} />
                        </marker>
                      )}
                    </g>
                  ))}
                </defs>
              </svg>

              <Background color="#1f2937" gap={20} />
              <Controls className="[&>button]:bg-gray-800 [&>button]:border-gray-700 [&>button]:text-gray-400" />
              <MiniMap nodeColor="#374151" maskColor="rgba(3,7,18,0.7)" className="!bg-gray-900 !border !border-gray-700 rounded" />

              {/* Layout toggle */}
              <div style={{ position: 'absolute', top: 10, right: detailPanel ? 288 : 10, zIndex: 10 }} className="flex gap-1">
                {(['LR', 'TB'] as RankDir[]).map((dir) => (
                  <button
                    key={dir}
                    onClick={() => setRankdir(dir)}
                    className={`px-2 py-1 text-[10px] font-mono rounded border transition-colors ${
                      rankdir === dir
                        ? 'bg-blue-900/60 border-blue-600 text-blue-300'
                        : 'bg-gray-900/80 border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-600'
                    }`}
                  >
                    {dir === 'LR' ? '⇢ LR' : '⇣ TB'}
                  </button>
                ))}
              </div>

              {/* Legend */}
              <div
                style={{ position: 'absolute', top: 10, left: 10, zIndex: 10 }}
                className="bg-gray-900/90 border border-gray-700 rounded px-3 py-2 text-[10px] font-mono space-y-1 pointer-events-none"
              >
                {(Object.entries(DIRECTION_COLOR) as [EdgeDirection, string][]).map(([dir, color]) => (
                  <div key={dir} className="flex items-center gap-2">
                    <svg width="24" height="4"><line x1="0" y1="2" x2="24" y2="2" stroke={color} strokeWidth="2" strokeDasharray={dir === 'uncertain' ? '4 2' : undefined} /></svg>
                    <span style={{ color }}>{dir}</span>
                  </div>
                ))}
                <div className="text-gray-600 mt-1">click node → drill down</div>
                <div className="text-gray-600">click edge label → details</div>
              </div>
            </ReactFlow>

            {/* Interface detail panel */}
            {detailPanel && (
              <InterfaceDetailPanel
                sourceLabel={detailPanel.sourceLabel}
                targetLabel={detailPanel.targetLabel}
                interfaces={detailPanel.interfaces}
                onClose={() => setDetailPanel(null)}
              />
            )}
          </div>
        </EdgeClickCtx.Provider>
      </SelectionCtx.Provider>
    </div>
  );
}
