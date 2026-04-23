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

  // Index file analyses by filename for O(1) lookup in the loop below.
  const fileAnalysisByName = new Map(analysis.files.map((f) => [f.filename, f]));

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
      for (const prod of producers) {
        // Skip the generic phantom edge only if this specific message constant is
        // explicitly handled by an isExternal send call (tracked via msgConstants).
        // A broad "any isExternal call in this file" check suppresses phantom edges
        // for unrelated message constants in the same file.
        const fa = fileAnalysisByName.get(prod.filename);
        const coveredByExternal = fa?.ipc.some(
          (c) => c.isExternal &&
            (c.direction === 'send' || c.direction === 'bidirectional' || c.direction === 'control') &&
            c.msgConstants?.includes(msg.msgTypeConstant)
        );
        if (!coveredByExternal) addPhantomEdge(prod.filename, EXTERNAL_NODE_ID);
      }
    }

    if (consumers.length > 0 && producers.length === 0) {
      for (const cons of consumers) {
        const fa = fileAnalysisByName.get(cons.filename);
        const coveredByExternal = fa?.ipc.some(
          (c) => c.isExternal &&
            (c.direction === 'recv' || c.direction === 'bidirectional') &&
            c.msgConstants?.includes(msg.msgTypeConstant)
        );
        if (!coveredByExternal) addPhantomEdge(EXTERNAL_NODE_ID, cons.filename);
      }
    }
  }

  // ── 2c. IPC-only phantom edges ───────────────────────────────────────────────
  const SEND_CALL_NAMES = new Set(['send', 'sendto', 'write', 'mq_send', 'fwrite']);
  const RECV_CALL_NAMES = new Set(['recv', 'recvfrom', 'read', 'mq_receive', 'fread']);

  function ipcIsSend(ipcCall: { detail: string; type: IpcType; direction?: string }): boolean {
    const callName = ipcCall.detail.split('(')[0].trim().toLowerCase();
    return SEND_CALL_NAMES.has(callName) || ipcCall.type === 'socket-send' || ipcCall.type === 'mqueue'
      || ipcCall.direction === 'send' || ipcCall.direction === 'bidirectional' || ipcCall.direction === 'control';
  }

  function ipcIsRecv(ipcCall: { detail: string; type: IpcType; direction?: string }): boolean {
    const callName = ipcCall.detail.split('(')[0].trim().toLowerCase();
    return RECV_CALL_NAMES.has(callName) || ipcCall.type === 'socket-recv'
      || ipcCall.direction === 'recv' || ipcCall.direction === 'bidirectional';
  }

  function addExternalEdge(source: string, target: string, transport: IpcType | null, confident: boolean) {
    const key = `${source}→${target}`;
    if (!edgeMap.has(key)) {
      edgeMap.set(key, { source, target, msgTypes: [], transport, confident });
    }
  }

  for (const fa of analysis.files) {
    // Pass 1: isExternal calls — always create edges to named or per-file external nodes.
    // Named patterns (externalName set) share a node across all files using that name.
    // Unnamed patterns get a node per file so unrelated externals aren't conflated.
    for (const ipcCall of fa.ipc) {
      if (!ipcCall.isExternal) continue;

      const label = ipcCall.externalName?.trim() || '? External';
      const normalizedName = ipcCall.externalName?.trim()
        ? ipcCall.externalName.trim().toLowerCase().replace(/\W+/g, '_')
        : `file__${fa.filename}`;
      const nodeId = `__external__${normalizedName}`;

      if (!nodeMap.has(nodeId)) {
        nodeMap.set(nodeId, {
          id: nodeId,
          type: 'externalNode',
          position: { x: 0, y: 0 },
          data: { label },
        });
      }

      // For isExternal calls, use direction directly — same logic as buildAppGraph
      const extIsSend = ipcCall.direction !== 'recv';
      const extIsRecv = ipcCall.direction === 'recv' || ipcCall.direction === 'bidirectional';
      const callMsgNames = [
        ...(ipcCall.msgConstants ?? []),
        ...(ipcCall.impliedStructs ?? []),
        ...(ipcCall.candidateTypes ?? []),
      ];
      if (extIsSend) {
        addExternalEdge(fa.filename, nodeId, ipcCall.type, true);
        const edge = edgeMap.get(`${fa.filename}→${nodeId}`);
        if (edge) {
          for (const mc of callMsgNames) {
            if (!edge.msgTypes.includes(mc)) edge.msgTypes.push(mc);
          }
        }
      }
      if (extIsRecv) {
        addExternalEdge(nodeId, fa.filename, ipcCall.type, true);
        const edge = edgeMap.get(`${nodeId}→${fa.filename}`);
        if (edge) {
          for (const mc of callMsgNames) {
            if (!edge.msgTypes.includes(mc)) edge.msgTypes.push(mc);
          }
        }
      }
    }

    // Pass 2: standard (non-isExternal) IPC calls — add generic ? External edge only
    // if the file has no outgoing/incoming edges yet (avoids spurious connections).
    let hasSend = false;
    let hasRecv = false;
    for (const ipcCall of fa.ipc) {
      if (ipcCall.isExternal) continue;
      if (ipcIsSend(ipcCall)) hasSend = true;
      if (ipcIsRecv(ipcCall)) hasRecv = true;
    }

    if (!hasSend && !hasRecv) continue;

    const hasOutgoing = [...edgeMap.keys()].some((k) => k.startsWith(`${fa.filename}→`));
    const hasIncoming = [...edgeMap.keys()].some((k) => k.endsWith(`→${fa.filename}`));

    if (hasSend && !hasOutgoing) {
      needsPhantom = true;
      addExternalEdge(fa.filename, EXTERNAL_NODE_ID,
        fa.ipc.find((c) => c.type === 'socket-send' || c.direction === 'send')?.type ?? null, true);
    }
    if (hasRecv && !hasIncoming) {
      needsPhantom = true;
      addExternalEdge(EXTERNAL_NODE_ID, fa.filename,
        fa.ipc.find((c) => c.type === 'socket-recv' || c.direction === 'recv')?.type ?? null, true);
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
    const isExternal = node.type === 'externalNode';
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
      const isExternal = node.type === 'externalNode';
      const w = isExternal ? EXTERNAL_W : NODE_W;
      const h = isExternal ? EXTERNAL_H : NODE_H;
      node.position = { x: pos.x - w / 2, y: pos.y - h / 2 };
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
