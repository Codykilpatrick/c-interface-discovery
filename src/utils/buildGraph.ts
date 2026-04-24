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
  hasDangling: boolean;
}

export type EdgeDirection = 'unidirectional' | 'bidirectional' | 'uncertain';

export interface MsgEdgeData extends Record<string, unknown> {
  msgTypes: string[];
  transport: IpcType | null;
  confident: boolean;
  direction: EdgeDirection;
}

export type ProcessNode = Node<ProcessNodeData, 'processNode'>;
export type MsgEdge    = Edge<MsgEdgeData,    'msgEdge'>;

const NODE_W = 200;
const NODE_H = 80;

export type RankDir = 'LR' | 'TB';

export function buildGraph(analysis: StringAnalysis, rankdir: RankDir = 'LR'): {
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
        hasDangling: false,
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
      if (
        node?.type === 'processNode' &&
        !node.data.producedMsgs.includes(msg.msgTypeConstant)
      ) {
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
      if (
        node?.type === 'processNode' &&
        !node.data.consumedMsgs.includes(msg.msgTypeConstant)
      ) {
        node.data.consumedMsgs.push(msg.msgTypeConstant);
      }
    }
  }

  // ── 2b. Flag incomplete messages (only producers or only consumers) ──────────
  for (const msg of analysis.messageInterfaces) {
    const producers = msg.fileRoles.filter((r) => r.role === 'producer' || r.role === 'both');
    const consumers = msg.fileRoles.filter((r) => r.role === 'consumer' || r.role === 'both');

    if (producers.length === 0 && consumers.length === 0) continue;

    if (producers.length > 0 && consumers.length === 0) {
      msg.incomplete = true;
      for (const prod of producers) {
        const node = nodeMap.get(prod.filename);
        if (node) node.data.hasDangling = true;
      }
    }
    if (consumers.length > 0 && producers.length === 0) {
      msg.incomplete = true;
      for (const cons of consumers) {
        const node = nodeMap.get(cons.filename);
        if (node) node.data.hasDangling = true;
      }
    }
  }

  // ── 3. Run dagre layout ─────────────────────────────────────────────────────
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  const nodeCount = nodeMap.size;
  const nodesep = nodeCount > 15 ? 40 : 60;
  const ranksep = nodeCount > 15 ? 180 : 140;
  g.setGraph({ rankdir, nodesep, ranksep, align: 'DL' });

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

  // ── 4. Collapse reciprocal pairs → bidirectional edges ──────────────────────
  const dropped = new Set<string>();
  for (const [key, e] of edgeMap) {
    if (dropped.has(key)) continue;
    const reverseKey = `${e.target}→${e.source}`;
    if (edgeMap.has(reverseKey) && !dropped.has(reverseKey)) {
      // Merge THIS edge's msgTypes INTO the reverse (kept) edge, then drop this one.
      // A collapsed pair is only truly bidirectional if at least one side had
      // confirmed IPC direction — otherwise both sides were fallback 'both' roles
      // and the edge should remain uncertain.
      const reverse = edgeMap.get(reverseKey)!;
      for (const m of e.msgTypes) {
        if (!reverse.msgTypes.includes(m)) reverse.msgTypes.push(m);
      }
      reverse.confident = reverse.confident || e.confident;
      dropped.add(key);
    }
  }
  for (const key of dropped) edgeMap.delete(key);

  // ── 5. Assemble ─────────────────────────────────────────────────────────────
  const nodes = [...nodeMap.values()];

  const edges: MsgEdge[] = [...edgeMap.entries()].map(([key, e]) => {
    const reverseKey = `${e.target}→${e.source}`;
    const wasPair = dropped.has(reverseKey); // the key we dropped was the pair
    // Only call it bidirectional if confidence was established; otherwise both
    // sides were fallback 'both' roles (no IPC calls detected) → uncertain.
    const isBidirectional = wasPair && e.confident;
    const direction: EdgeDirection = isBidirectional
      ? 'bidirectional'
      : e.confident ? 'unidirectional' : 'uncertain';

    return {
      id: key,
      source: e.source,
      target: e.target,
      type: 'msgEdge' as const,
      animated: direction === 'uncertain',
      data: {
        msgTypes: e.msgTypes,
        transport: e.transport,
        confident: e.confident,
        direction,
      },
    };
  });

  return { nodes, edges };
}
