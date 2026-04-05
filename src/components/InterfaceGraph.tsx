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
import { useMemo, useState } from 'react';
import type { IpcType, StringAnalysis } from '../analyzer/types';
import {
  buildGraph,
  type MsgEdge,
  type MsgEdgeData,
  type ProcessNode,
  type ProcessNodeData,
} from '../utils/buildGraph';

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

function ipcColor(type: IpcType | null | undefined): string {
  return (type && IPC_COLOR[type]) ?? '#4b5563';
}

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
  const color = ipcColor(edgeData?.transport);
  const strokeDash = edgeData?.confident === false ? '6 3' : undefined;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: selected ? '#60a5fa' : color,
          strokeWidth: selected ? 2 : 1.5,
          strokeDasharray: strokeDash,
          opacity: 0.8,
        }}
        markerEnd="url(#cid-arrow)"
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
              style={{ borderColor: color, color }}
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
                <div style={{ color: ipcColor(null) }} className="hover:text-gray-400">
                  +{edgeData.msgTypes.length - 2} more
                </div>
              )}
              {expanded && edgeData.msgTypes.length > 2 && (
                <div style={{ color: ipcColor(null) }}>▲ collapse</div>
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
  const { nodes, edges } = useMemo(() => buildGraph(analysis), [analysis]);

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
          <marker id="cid-arrow" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="#4b5563" />
          </marker>
        </defs>
      </svg>

      <ReactFlow
        nodes={nodes}
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
