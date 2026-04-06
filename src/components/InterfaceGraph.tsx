import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type NodeProps,
  type EdgeProps,
  type NodeTypes,
  type EdgeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMemo, useState, useEffect } from 'react';
import { useNodesState } from '@xyflow/react';
import type { IpcType, StringAnalysis } from '../analyzer/types';
import {
  buildGraph,
  type EdgeDirection,
  type MsgEdge,
  type MsgEdgeData,
  type ProcessNode,
  type ProcessNodeData,
} from '../utils/buildGraph';

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

function ProcessNodeComponent({ data, selected }: NodeProps<ProcessNode>) {
  const { label, ipcTypes, hasUnknown } = data as ProcessNodeData;
  return (
    <div
      className="bg-gray-900 rounded-lg px-3 py-2 w-48 shadow-lg transition-all cursor-pointer group"
      style={{ border: `2px solid ${selected ? '#60a5fa' : '#374151'}` }}
      onMouseEnter={(e) => { if (!selected) (e.currentTarget as HTMLDivElement).style.borderColor = '#6b7280'; }}
      onMouseLeave={(e) => { if (!selected) (e.currentTarget as HTMLDivElement).style.borderColor = '#374151'; }}
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

// ── Custom edge ───────────────────────────────────────────────────────────────

function MsgEdgeComponent({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, data, selected,
}: EdgeProps<MsgEdge>) {
  const [expanded, setExpanded] = useState(false);
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
  });

  const edgeData = data as MsgEdgeData | undefined;
  const direction = edgeData?.direction ?? 'uncertain';
  const color = selected ? '#e2e8f0' : DIRECTION_COLOR[direction];
  const strokeDash = direction === 'uncertain' ? '6 3' : undefined;
  const markerId = `cid-arrow-${direction}`;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: color,
          strokeWidth: selected ? 2 : 1.5,
          strokeDasharray: strokeDash,
          opacity: 0.85,
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

const nodeTypes: NodeTypes = { processNode: ProcessNodeComponent };
const edgeTypes: EdgeTypes = { msgEdge: MsgEdgeComponent };

// ── Main component ────────────────────────────────────────────────────────────

interface InterfaceGraphProps {
  analysis: StringAnalysis;
  onSelectFile: (filename: string) => void;
}

export default function InterfaceGraph({ analysis, onSelectFile }: InterfaceGraphProps) {
  const { nodes: initialNodes, edges } = useMemo(() => buildGraph(analysis), [analysis]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);

  // Reset positions when the analysis changes (new files loaded / re-analyzed)
  useEffect(() => { setNodes(initialNodes); }, [initialNodes, setNodes]);

  if (nodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-600 text-sm">
        No source files loaded yet
      </div>
    );
  }

  return (
    <div className="w-full h-[520px] rounded-lg overflow-hidden border border-gray-800">
      <svg style={{ position: 'absolute', width: 0, height: 0 }}>
        <defs>
          {(Object.entries(DIRECTION_COLOR) as [EdgeDirection, string][]).map(([dir, color]) => (
            <g key={dir}>
              <marker id={`cid-arrow-${dir}`} markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill={color} />
              </marker>
              {dir === 'bidirectional' && (
                <marker id={`cid-arrow-${dir}-start`} markerWidth="8" markerHeight="6" refX="0" refY="3" orient="auto">
                  <polygon points="8 0, 0 3, 8 6" fill={color} />
                </marker>
              )}
            </g>
          ))}
        </defs>
      </svg>

      <ReactFlow
        nodes={nodes}
        onNodesChange={onNodesChange}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        onNodeClick={(_, node) => onSelectFile(node.data.filename as string)}
        colorMode="dark"
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#1f2937" gap={20} />
        <Controls className="[&>button]:bg-gray-800 [&>button]:border-gray-700 [&>button]:text-gray-400" />
        <MiniMap
          nodeColor="#374151"
          maskColor="rgba(3,7,18,0.7)"
          className="!bg-gray-900 !border !border-gray-700 rounded"
        />
      </ReactFlow>
    </div>
  );
}
