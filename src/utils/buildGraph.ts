import type { Edge, Node } from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import type { IpcType, StringAnalysis } from '../analyzer/types';

export interface ProcessNodeData extends Record<string, unknown> {
  label: string;
  filename: string;
  ipcTypes: IpcType[];
  producedMsgs: string[];
  consumedMsgs: string[];
  hasUnknown: boolean;
}

export interface MsgEdgeData extends Record<string, unknown> {
  msgTypes: string[];
  transport: IpcType | null;
  confident: boolean;
}

export type ProcessNode = Node<ProcessNodeData, 'processNode'>;
export type MsgEdge    = Edge<MsgEdgeData,    'msgEdge'>;

const NODE_W = 200;
const NODE_H = 80;

export function buildGraph(analysis: StringAnalysis): {
  nodes: ProcessNode[];
  edges: MsgEdge[];
} {
  // ── 1. Build node map ───────────────────────────────────────────────────────
  const nodeMap = new Map<string, ProcessNode>();

  for (const fa of analysis.files) {
    const ipcTypes = [...new Set(fa.ipc.map((c) => c.type))];
    nodeMap.set(fa.filename, {
      id: fa.filename,
      type: 'processNode',
      position: { x: 0, y: 0 },
      data: {
        label: fa.filename.replace(/\.[^.]+$/, ''),
        filename: fa.filename,
        ipcTypes,
        producedMsgs: [],
        consumedMsgs: [],
        hasUnknown: fa.unknownCalls.length > 0,
      },
    });
  }

  // ── 2. Build edges from message interface fileRoles ─────────────────────────
  const edgeMap = new Map<string, {
    source: string;
    target: string;
    msgTypes: string[];
    transport: IpcType | null;
    confident: boolean;
  }>();

  for (const msg of analysis.messageInterfaces) {
    const producers = msg.fileRoles.filter((r) => r.role === 'producer' || r.role === 'both');
    const consumers = msg.fileRoles.filter((r) => r.role === 'consumer' || r.role === 'both');

    for (const prod of producers) {
      const node = nodeMap.get(prod.filename);
      if (node && !node.data.producedMsgs.includes(msg.msgTypeConstant)) {
        node.data.producedMsgs.push(msg.msgTypeConstant);
      }

      for (const cons of consumers) {
        if (prod.filename === cons.filename) continue;
        const key = `${prod.filename}→${cons.filename}`;
        const existing = edgeMap.get(key);
        if (existing) {
          if (!existing.msgTypes.includes(msg.msgTypeConstant)) {
            existing.msgTypes.push(msg.msgTypeConstant);
          }
        } else {
          edgeMap.set(key, {
            source: prod.filename,
            target: cons.filename,
            msgTypes: [msg.msgTypeConstant],
            transport: msg.transport,
            confident: msg.directionConfident,
          });
        }
      }
    }

    for (const cons of consumers) {
      const node = nodeMap.get(cons.filename);
      if (node && !node.data.consumedMsgs.includes(msg.msgTypeConstant)) {
        node.data.consumedMsgs.push(msg.msgTypeConstant);
      }
    }
  }

  // ── 3. Run dagre layout ─────────────────────────────────────────────────────
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 120 });

  for (const node of nodeMap.values()) {
    g.setNode(node.id, { width: NODE_W, height: NODE_H });
  }
  for (const e of edgeMap.values()) {
    g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  for (const node of nodeMap.values()) {
    const pos = g.node(node.id);
    if (pos) {
      node.position = { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 };
    }
  }

  // ── 4. Assemble ─────────────────────────────────────────────────────────────
  const nodes = [...nodeMap.values()];

  const edges: MsgEdge[] = [...edgeMap.entries()].map(([key, e]) => ({
    id: key,
    source: e.source,
    target: e.target,
    type: 'msgEdge' as const,
    animated: !e.confident,
    data: {
      msgTypes: e.msgTypes,
      transport: e.transport,
      confident: e.confident,
    },
  }));

  return { nodes, edges };
}
