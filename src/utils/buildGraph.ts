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

export type EdgeDirection = 'unidirectional' | 'bidirectional' | 'uncertain';

export interface MsgEdgeData extends Record<string, unknown> {
  msgTypes: string[];
  transport: IpcType | null;
  confident: boolean;
  direction: EdgeDirection;
}

export type ProcessNode = Node<ProcessNodeData, 'processNode'>;
export type MsgEdge    = Edge<MsgEdgeData,    'msgEdge'>;

export const EXTERNAL_NODE_ID = '__external__';

export interface ExternalNodeData extends Record<string, unknown> {
  label: string;
}
export type ExternalNode = Node<ExternalNodeData, 'externalNode'>;

const NODE_W = 200;
const NODE_H = 80;
const EXTERNAL_W = 140;
const EXTERNAL_H = 60;

export type RankDir = 'LR' | 'TB';

export function buildGraph(analysis: StringAnalysis, rankdir: RankDir = 'LR'): {
  nodes: (ProcessNode | ExternalNode)[];
  edges: MsgEdge[];
} {
  // ── 1. Build node map ───────────────────────────────────────────────────────
  const nodeMap = new Map<string, ProcessNode | ExternalNode>();

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

  // ── 2b. Phantom edges for one-sided messages ────────────────────────────────
  let needsPhantom = false;

  for (const msg of analysis.messageInterfaces) {
    const producers = msg.fileRoles.filter((r) => r.role === 'producer' || r.role === 'both');
    const consumers = msg.fileRoles.filter((r) => r.role === 'consumer' || r.role === 'both');

    // Skip messages with no roles at all — not referenced in any loaded file
    if (producers.length === 0 && consumers.length === 0) continue;

    const addPhantomEdge = (source: string, target: string) => {
      const key = `${source}→${target}`;
      const existing = edgeMap.get(key);
      if (existing) {
        if (!existing.msgTypes.includes(msg.msgTypeConstant)) {
          existing.msgTypes.push(msg.msgTypeConstant);
        }
      } else {
        needsPhantom = true;
        edgeMap.set(key, {
          source,
          target,
          msgTypes: [msg.msgTypeConstant],
          transport: msg.transport,
          confident: false, // direction to/from external is always uncertain
        });
      }
    };

    if (producers.length > 0 && consumers.length === 0) {
      for (const prod of producers) addPhantomEdge(prod.filename, EXTERNAL_NODE_ID);
    }

    if (consumers.length > 0 && producers.length === 0) {
      for (const cons of consumers) addPhantomEdge(EXTERNAL_NODE_ID, cons.filename);
    }
  }

  if (needsPhantom) {
    nodeMap.set(EXTERNAL_NODE_ID, {
      id: EXTERNAL_NODE_ID,
      type: 'externalNode',
      position: { x: 0, y: 0 },
      data: { label: '? External' },
    });
  }

  // ── 3. Run dagre layout ─────────────────────────────────────────────────────
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  const nodeCount = nodeMap.size;
  const nodesep = nodeCount > 15 ? 40 : 60;
  const ranksep = nodeCount > 15 ? 180 : 140;
  g.setGraph({ rankdir, nodesep, ranksep, align: 'DL' });

  for (const node of nodeMap.values()) {
    const isExternal = node.id === EXTERNAL_NODE_ID;
    g.setNode(node.id, {
      width:  isExternal ? EXTERNAL_W : NODE_W,
      height: isExternal ? EXTERNAL_H : NODE_H,
    });
  }
  for (const e of edgeMap.values()) {
    g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  for (const node of nodeMap.values()) {
    const pos = g.node(node.id);
    if (pos) {
      const isExternal = node.id === EXTERNAL_NODE_ID;
      const w = isExternal ? EXTERNAL_W : NODE_W;
      const h = isExternal ? EXTERNAL_H : NODE_H;
      node.position = { x: pos.x - w / 2, y: pos.y - h / 2 };
    }
  }

  // ── 4. Collapse reciprocal pairs → bidirectional edges ──────────────────────
  const dropped = new Set<string>();
  for (const [key, e] of edgeMap) {
    const reverseKey = `${e.target}→${e.source}`;
    if (edgeMap.has(reverseKey) && !dropped.has(reverseKey)) {
      // Merge reverse edge's msgTypes into this one, then drop the reverse
      const reverse = edgeMap.get(reverseKey)!;
      for (const m of reverse.msgTypes) {
        if (!e.msgTypes.includes(m)) e.msgTypes.push(m);
      }
      dropped.add(key); // keep the reverse key, drop this one (arbitrary but consistent)
    }
  }
  for (const key of dropped) edgeMap.delete(key);

  // ── 5. Assemble ─────────────────────────────────────────────────────────────
  const nodes = [...nodeMap.values()];

  const edges: MsgEdge[] = [...edgeMap.entries()].map(([key, e]) => {
    const reverseKey = `${e.target}→${e.source}`;
    const isBidirectional = dropped.has(reverseKey); // the key we dropped was the pair
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
