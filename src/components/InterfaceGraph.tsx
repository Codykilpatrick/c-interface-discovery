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
import type { IpcType, StringAnalysis } from '../analyzer/types';
import {
  buildGraph,
  EXTERNAL_NODE_ID,
  type EdgeDirection,
  type ExternalNode,
  type MsgEdge,
  type MsgEdgeData,
  type ProcessNode,
  type ProcessNodeData,
  type RankDir,
} from '../utils/buildGraph';

// ── Selection context ─────────────────────────────────────────────────────────

interface GraphSelection {
  selectedNodeId: string | null;
  connectedEdgeIds: Set<string>;
  connectedNodeIds: Set<string>;
}
const SelectionContext = createContext<GraphSelection>({
  selectedNodeId: null,
  connectedEdgeIds: new Set(),
  connectedNodeIds: new Set(),
});

// ── IPC color map (used for node badges only) ─────────────────────────────────

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

function ipcColor(type: IpcType | null | undefined): string {
  return (type && IPC_COLOR[type]) ?? '#4b5563';
}

// ── Edge direction colors ─────────────────────────────────────────────────────

const DIRECTION_COLOR: Record<EdgeDirection, string> = {
  unidirectional: '#60a5fa',  // blue  — confident send
  bidirectional:  '#a78bfa',  // purple — both directions
  uncertain:      '#fbbf24',  // amber  — direction unknown
};

// ── Custom node ───────────────────────────────────────────────────────────────

function ProcessNodeComponent({ data, selected, id }: NodeProps<ProcessNode>) {
  const { label, ipcTypes, hasUnknown } = data as ProcessNodeData;
  const { selectedNodeId, connectedNodeIds } = useContext(SelectionContext);
  const isSelected = id === selectedNodeId;
  const isDimmed = selectedNodeId !== null && !isSelected && !connectedNodeIds.has(id);
  return (
    <div
      className="bg-gray-900 rounded-lg px-3 py-2 w-48 shadow-lg transition-all cursor-pointer group"
      style={{
        border: `2px solid ${isSelected ? '#60a5fa' : selected ? '#60a5fa' : '#374151'}`,
        opacity: isDimmed ? 0.25 : 1,
      }}
      onMouseEnter={(e) => { if (!isSelected && !selected) (e.currentTarget as HTMLDivElement).style.borderColor = '#6b7280'; }}
      onMouseLeave={(e) => { if (!isSelected && !selected) (e.currentTarget as HTMLDivElement).style.borderColor = '#374151'; }}
    >
      <Handle type="target" position={Position.Left}  style={{ background: '#4b5563' }} />
      <Handle type="source" position={Position.Right} style={{ background: '#4b5563' }} />

      <div className="font-mono text-sm font-semibold text-gray-100 truncate mb-1.5">
        {label}
      </div>

      {ipcTypes.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1">
          {(ipcTypes as IpcType[]).map((t) => (
            <span
              key={t}
              style={{ color: ipcColor(t), borderColor: ipcColor(t) }}
              className="text-[10px] font-mono border rounded px-1 opacity-80"
            >
              {t}
            </span>
          ))}
        </div>
      )}

      {hasUnknown && (
        <div className="text-[10px] text-yellow-500 opacity-70">⚠ unknown calls</div>
      )}
    </div>
  );
}

// ── External phantom node ─────────────────────────────────────────────────────

function ExternalNodeComponent({ selected, id, data }: NodeProps<ExternalNode>) {
  const { selectedNodeId, connectedNodeIds } = useContext(SelectionContext);
  const isSelected = id === selectedNodeId;
  const isDimmed = selectedNodeId !== null && !isSelected && !connectedNodeIds.has(id);
  const isNamed = data.label !== '? External';
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
      {isNamed
        ? <div className="text-xs text-gray-300 font-mono text-center break-all">{data.label}</div>
        : <>
            <div className="text-2xl text-gray-600 leading-none mb-1">?</div>
            <div className="text-xs text-gray-500 font-mono">{data.label}</div>
          </>
      }
    </div>
  );
}

// ── Custom edge ───────────────────────────────────────────────────────────────

function MsgEdgeComponent({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, data, selected,
}: EdgeProps<MsgEdge>) {
  const [expanded, setExpanded] = useState(false);
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
    borderRadius: 8,
  });

  const { selectedNodeId, connectedEdgeIds } = useContext(SelectionContext);
  const isHighlighted = selectedNodeId !== null && connectedEdgeIds.has(id);
  const isDimmed = selectedNodeId !== null && !connectedEdgeIds.has(id);

  const edgeData = data as MsgEdgeData | undefined;
  const direction = edgeData?.direction ?? 'uncertain';
  const color = selected || isHighlighted ? '#e2e8f0' : DIRECTION_COLOR[direction];
  const strokeDash = direction === 'uncertain' ? '6 3' : undefined;
  const markerId = `cid-arrow-${direction}`;

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
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
            opacity: isDimmed ? 0.08 : 1,
            transition: 'opacity 0.15s',
          }}
          className="nodrag nopan"
        >
          {edgeData?.msgTypes && (
            <div
              role="button"
              style={{ borderColor: color, color: color }}
              className="bg-gray-950 border rounded px-1.5 py-0.5 text-[10px] font-mono max-w-36 text-center leading-tight cursor-pointer hover:brightness-125 transition-all select-none"
              onClick={() => setExpanded((v) => !v)}
              title="Click to expand"
            >
              {(expanded ? edgeData.msgTypes : edgeData.msgTypes.slice(0, 2)).map((m) => (
                <div key={m} className="truncate">
                  {m.replace(/^MSG_TYPE_|^MSG_ID_|^PKT_TYPE_|^OPCODE_/, '')}
                </div>
              ))}
              {!expanded && edgeData.msgTypes.length > 2 && (
                <div className="text-gray-500 hover:text-gray-400">
                  +{edgeData.msgTypes.length - 2} more
                </div>
              )}
              {expanded && edgeData.msgTypes.length > 2 && (
                <div className="text-gray-500">▲ collapse</div>
              )}
            </div>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes: NodeTypes = {
  processNode:  ProcessNodeComponent,
  externalNode: ExternalNodeComponent,
};
const edgeTypes: EdgeTypes = { msgEdge: MsgEdgeComponent };

// ── Main component ────────────────────────────────────────────────────────────

interface InterfaceGraphProps {
  analysis: StringAnalysis;
  onSelectFile: (filename: string) => void;
}

export default function InterfaceGraph({ analysis, onSelectFile }: InterfaceGraphProps) {
  const [rankdir, setRankdir] = useState<RankDir>('LR');
  const { nodes: initialNodes, edges } = useMemo(() => buildGraph(analysis, rankdir), [analysis, rankdir]);
  const [nodes, setNodes, onNodesChange] = useNodesState<ProcessNode | ExternalNode>(initialNodes);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Reset positions and selection when the analysis changes or layout direction changes
  useEffect(() => {
    setNodes(initialNodes);
    setSelectedNodeId(null);
  }, [initialNodes, setNodes]);

  // Compute which edges/nodes are connected to the selected node
  const { connectedEdgeIds, connectedNodeIds } = useMemo<{
    connectedEdgeIds: Set<string>;
    connectedNodeIds: Set<string>;
  }>(() => {
    if (!selectedNodeId) return { connectedEdgeIds: new Set(), connectedNodeIds: new Set() };
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

  if (nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-600 text-sm">
        No source files loaded yet
      </div>
    );
  }

  return (
    <SelectionContext.Provider value={selectionCtx}>
      <div className="w-full rounded-lg overflow-hidden border border-gray-800" style={{ height: Math.max(520, Math.min(800, nodes.length * 60 + 120)) }}>
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
            setSelectedNodeId((prev) => prev === nodeId ? null : nodeId);
            if (nodeId !== EXTERNAL_NODE_ID) {
              onSelectFile(node.data.filename as string);
            }
          }}
          onPaneClick={() => setSelectedNodeId(null)}
          colorMode="dark"
          proOptions={{ hideAttribution: true }}
        >
          {/* Arrow marker defs — must live inside ReactFlow's SVG context via a Panel overlay */}
          <svg style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}>
            <defs>
              {(Object.entries(DIRECTION_COLOR) as [EdgeDirection, string][]).map(([dir, color]) => (
                <g key={dir}>
                  <marker id={`cid-arrow-${dir}`} markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                    <polygon points="0 0, 8 3, 0 6" fill={color} />
                  </marker>
                  {dir === 'bidirectional' && (
                    <marker id={`cid-arrow-${dir}-start`} markerWidth="8" markerHeight="6" refX="1" refY="3" orient="auto-start-reverse">
                      <polygon points="0 0, 8 3, 0 6" fill={color} />
                    </marker>
                  )}
                </g>
              ))}
              <marker id="cid-arrow-highlight" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill="#e2e8f0" />
              </marker>
            </defs>
          </svg>

          <Background color="#1f2937" gap={20} />
          <Controls className="[&>button]:bg-gray-800 [&>button]:border-gray-700 [&>button]:text-gray-400" />
          <MiniMap
            nodeColor="#374151"
            maskColor="rgba(3,7,18,0.7)"
            className="!bg-gray-900 !border !border-gray-700 rounded"
          />

          {/* Layout direction toggle */}
          <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 10 }} className="flex gap-1">
            {(['LR', 'TB'] as RankDir[]).map((dir) => (
              <button
                key={dir}
                onClick={() => setRankdir(dir)}
                className={`px-2 py-1 text-[10px] font-mono rounded border transition-colors ${
                  rankdir === dir
                    ? 'bg-blue-900/60 border-blue-600 text-blue-300'
                    : 'bg-gray-900/80 border-gray-700 text-gray-500 hover:text-gray-300 hover:border-gray-600'
                }`}
                title={dir === 'LR' ? 'Left → Right layout' : 'Top → Bottom layout'}
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
            <div className="text-gray-600 mt-1">click node to highlight</div>
          </div>
        </ReactFlow>
      </div>
    </SelectionContext.Provider>
  );
}
