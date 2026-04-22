import type { Edge, Node } from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import type { IpcType, MessageInterface, StringAnalysis } from '../analyzer/types';
import type { EdgeDirection, RankDir } from './buildGraph';

export interface AppNodeData extends Record<string, unknown> {
  label: string;
  appId: string;
  fileCount: number;
  ipcTypes: IpcType[];
  producedMsgs: string[];
  consumedMsgs: string[];
}

export interface CrossAppEdgeData extends Record<string, unknown> {
  msgTypes: string[];
  interfaces: MessageInterface[];
  transport: IpcType | null;
  direction: EdgeDirection;
  confident: boolean;
}

export interface AppExternalNodeData extends Record<string, unknown> {
  label: string;
}

export type AppNode         = Node<AppNodeData,         'appNode'>;
export type CrossAppEdge    = Edge<CrossAppEdgeData,    'crossAppEdge'>;
export type AppExternalNode = Node<AppExternalNodeData, 'appExternalNode'>;

export const APP_EXTERNAL_NODE_ID = '__app_external__';

export function appExternalNodeId(externalName?: string): string {
  return externalName
    ? `__app_external__${externalName.toLowerCase().replace(/\s+/g, '_')}`
    : APP_EXTERNAL_NODE_ID;
}

export function appExternalNodeLabel(externalName?: string): string {
  return externalName ? `? ${externalName}` : '? External';
}

const NODE_W = 200;
const NODE_H = 90;
const EXTERNAL_W = 140;
const EXTERNAL_H = 60;

export function buildAppGraph(
  groups: Array<{ id: string; name: string; analysis: StringAnalysis | null }>,
  rankdir: RankDir = 'LR'
): {
  nodes: (AppNode | AppExternalNode)[];
  edges: CrossAppEdge[];
} {
  const analyzedGroups = groups.filter((g) => g.analysis !== null);

  // ── 1. Build app nodes ──────────────────────────────────────────────────────
  const nodeMap = new Map<string, AppNode | AppExternalNode>();

  for (const g of groups) {
    const ipcTypes = g.analysis
      ? [...new Set(g.analysis.files.flatMap((f) => f.ipc.map((c) => c.type)))]
      : ([] as IpcType[]);

    nodeMap.set(g.id, {
      id: g.id,
      type: 'appNode',
      position: { x: 0, y: 0 },
      data: {
        label: g.name,
        appId: g.id,
        fileCount: g.analysis?.files.length ?? 0,
        ipcTypes,
        producedMsgs: [],
        consumedMsgs: [],
      },
    });
  }

  if (analyzedGroups.length === 0) {
    return { nodes: [...nodeMap.values()], edges: [] };
  }

  // ── 2. Build cross-app message map ──────────────────────────────────────────
  // For each message constant, track which apps produce and consume it.
  interface MsgEntry {
    producers: string[];                       // appIds
    consumers: string[];                       // appIds
    interfaces: Map<string, MessageInterface>; // appId → interface (prefer producer's)
    confident: boolean;
  }

  const msgMap = new Map<string, MsgEntry>();

  for (const g of analyzedGroups) {
    for (const msg of g.analysis!.messageInterfaces) {
      if (!msgMap.has(msg.msgTypeConstant)) {
        msgMap.set(msg.msgTypeConstant, {
          producers: [], consumers: [], interfaces: new Map(), confident: false,
        });
      }
      const entry = msgMap.get(msg.msgTypeConstant)!;

      const appProduces = msg.fileRoles.some((r) => r.role === 'producer' || r.role === 'both');
      const appConsumes = msg.fileRoles.some((r) => r.role === 'consumer' || r.role === 'both');

      if (appProduces && !entry.producers.includes(g.id)) {
        entry.producers.push(g.id);
        entry.interfaces.set(g.id, msg); // prefer producer's interface record
      }
      if (appConsumes && !entry.consumers.includes(g.id)) {
        entry.consumers.push(g.id);
        if (!entry.interfaces.has(g.id)) entry.interfaces.set(g.id, msg);
      }
      if (msg.directionConfident) entry.confident = true;
    }
  }

  // ── 3. Build cross-app edges ────────────────────────────────────────────────
  interface EdgeAccum {
    source: string;
    target: string;
    msgTypes: string[];
    interfaces: MessageInterface[];
    transport: IpcType | null;
    confident: boolean;
  }

  const edgeMap = new Map<string, EdgeAccum>();

  const addOrMerge = (source: string, target: string, msgConst: string, iface: MessageInterface, confident: boolean) => {
    const key = `${source}→${target}`;
    const existing = edgeMap.get(key);
    if (existing) {
      if (!existing.msgTypes.includes(msgConst)) {
        existing.msgTypes.push(msgConst);
        existing.interfaces.push(iface);
      }
      if (confident) existing.confident = true;
    } else {
      edgeMap.set(key, {
        source, target,
        msgTypes: [msgConst],
        interfaces: [iface],
        transport: iface.transport,
        confident,
      });
    }
  };

  for (const [msgConst, entry] of msgMap) {
    const { producers, consumers, interfaces, confident } = entry;

    // Update node produced/consumed lists
    for (const appId of producers) {
      const node = nodeMap.get(appId);
      if (node?.type === 'appNode' && !node.data.producedMsgs.includes(msgConst)) {
        node.data.producedMsgs.push(msgConst);
      }
    }
    for (const appId of consumers) {
      const node = nodeMap.get(appId);
      if (node?.type === 'appNode' && !node.data.consumedMsgs.includes(msgConst)) {
        node.data.consumedMsgs.push(msgConst);
      }
    }

    // Separate pure endpoints from transit apps (both produce AND consume same constant).
    // Transit apps are message brokers / routers — edges should route *through* them,
    // not skip them to create false direct connections between endpoints.
    const transitIds  = producers.filter((id) => consumers.includes(id));
    const pureProds   = producers.filter((id) => !consumers.includes(id));
    const pureCons    = consumers.filter((id) => !producers.includes(id));

    if (transitIds.length > 0) {
      // Route through transit: pure-producer → transit → pure-consumer
      for (const prodId of pureProds) {
        for (const transitId of transitIds) {
          const iface = interfaces.get(prodId) ?? interfaces.get(transitId) ?? [...interfaces.values()][0];
          addOrMerge(prodId, transitId, msgConst, iface, confident);
        }
      }
      for (const transitId of transitIds) {
        for (const consId of pureCons) {
          const iface = interfaces.get(transitId) ?? interfaces.get(consId) ?? [...interfaces.values()][0];
          addOrMerge(transitId, consId, msgConst, iface, confident);
        }
      }
    } else {
      // No transit apps — direct connections
      for (const prodId of pureProds) {
        for (const consId of pureCons) {
          if (prodId === consId) continue;
          const iface = interfaces.get(prodId) ?? interfaces.get(consId) ?? [...interfaces.values()][0];
          addOrMerge(prodId, consId, msgConst, iface, confident);
        }
      }
    }

    // Phantom edges for message constants with no peer in loaded apps → generic external.
    // Skip the phantom only if this specific constant is explicitly handled by an isExternal
    // call in that app (tracked via msgConstants). A broad "app has any isExternal call"
    // check incorrectly suppresses phantom edges for unrelated message constants.
    if (producers.length > 0 && consumers.length === 0) {
      for (const prodId of producers) {
        const group = analyzedGroups.find((g) => g.id === prodId);
        const coveredByExternal = group?.analysis?.files.some((f) =>
          f.ipc.some((c) => c.isExternal &&
            (c.direction === 'send' || c.direction === 'bidirectional' || c.direction === 'control') &&
            c.msgConstants?.includes(msgConst))
        );
        if (coveredByExternal) continue;
        if (!nodeMap.has(APP_EXTERNAL_NODE_ID)) {
          nodeMap.set(APP_EXTERNAL_NODE_ID, {
            id: APP_EXTERNAL_NODE_ID,
            type: 'appExternalNode',
            position: { x: 0, y: 0 },
            data: { label: '? External' },
          });
        }
        const iface = interfaces.get(prodId)!;
        addOrMerge(prodId, APP_EXTERNAL_NODE_ID, msgConst, iface, false);
      }
    }
    if (consumers.length > 0 && producers.length === 0) {
      for (const consId of consumers) {
        const group = analyzedGroups.find((g) => g.id === consId);
        const coveredByExternal = group?.analysis?.files.some((f) =>
          f.ipc.some((c) => c.isExternal &&
            (c.direction === 'recv' || c.direction === 'bidirectional') &&
            c.msgConstants?.includes(msgConst))
        );
        if (coveredByExternal) continue;
        if (!nodeMap.has(APP_EXTERNAL_NODE_ID)) {
          nodeMap.set(APP_EXTERNAL_NODE_ID, {
            id: APP_EXTERNAL_NODE_ID,
            type: 'appExternalNode',
            position: { x: 0, y: 0 },
            data: { label: '? External' },
          });
        }
        const iface = interfaces.get(consId)!;
        addOrMerge(APP_EXTERNAL_NODE_ID, consId, msgConst, iface, false);
      }
    }
  }

  // ── 3b. External IPC call nodes (custom patterns with isExternal=true) ────────
  // These are function-call patterns (e.g. "bummer_send") that explicitly target
  // a named external system. They don't correspond to message type constants so
  // they're not captured by the msgMap loop above.
  for (const g of analyzedGroups) {
    for (const file of g.analysis!.files) {
      for (const call of file.ipc) {
        if (!call.isExternal) continue;
        const extId  = appExternalNodeId(call.externalName);
        const extLabel = appExternalNodeLabel(call.externalName);
        if (!nodeMap.has(extId)) {
          nodeMap.set(extId, {
            id: extId,
            type: 'appExternalNode',
            position: { x: 0, y: 0 },
            data: { label: extLabel },
          });
        }
        // Build a synthetic MessageInterface stub so addOrMerge has something to store
        const syntheticIface = {
          msgTypeConstant: call.externalName ?? call.detail,
          msgTypeValue: '',
          struct: null,
          structResolved: false,
          direction: (call.direction === 'recv' ? 'inbound' : 'outbound') as import('../analyzer/types').MsgDirection,
          directionConfident: call.direction != null,
          transport: call.type,
          definedIn: file.filename,
          usedIn: [],
          fileRoles: [{ filename: file.filename, role: call.direction === 'recv' ? 'consumer' as const : 'producer' as const }],
        };
        const isSend = call.direction !== 'recv';
        const edgeSource = isSend ? g.id : extId;
        const edgeTarget = isSend ? extId : g.id;
        addOrMerge(edgeSource, edgeTarget, syntheticIface.msgTypeConstant, syntheticIface, true);
      }
    }
  }

  // ── 4. Collapse reciprocal pairs → bidirectional ────────────────────────────
  const dropped = new Set<string>();
  for (const [key, e] of edgeMap) {
    if (dropped.has(key)) continue;
    const reverseKey = `${e.target}→${e.source}`;
    if (edgeMap.has(reverseKey) && !dropped.has(reverseKey)) {
      // Merge THIS edge's data INTO the reverse (kept) edge, then drop this one.
      const reverse = edgeMap.get(reverseKey)!;
      for (const m of e.msgTypes) {
        if (!reverse.msgTypes.includes(m)) {
          reverse.msgTypes.push(m);
          reverse.interfaces.push(...e.interfaces.filter((i) => i.msgTypeConstant === m));
        }
      }
      reverse.confident = reverse.confident || e.confident;
      dropped.add(key);
    }
  }
  for (const key of dropped) edgeMap.delete(key);

  // ── 5. Dagre layout ─────────────────────────────────────────────────────────
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  const nodeCount = nodeMap.size;
  g.setGraph({
    rankdir,
    nodesep: nodeCount > 8 ? 40 : 60,
    ranksep: nodeCount > 8 ? 180 : 140,
    align: 'DL',
  });

  for (const node of nodeMap.values()) {
    const isExt = node.type === 'appExternalNode';
    g.setNode(node.id, { width: isExt ? EXTERNAL_W : NODE_W, height: isExt ? EXTERNAL_H : NODE_H });
  }
  for (const e of edgeMap.values()) g.setEdge(e.source, e.target);

  dagre.layout(g);

  for (const node of nodeMap.values()) {
    const pos = g.node(node.id);
    if (pos) {
      const isExt = node.type === 'appExternalNode';
      const w = isExt ? EXTERNAL_W : NODE_W;
      const h = isExt ? EXTERNAL_H : NODE_H;
      node.position = { x: pos.x - w / 2, y: pos.y - h / 2 };
    }
  }

  // ── 6. Assemble edges ───────────────────────────────────────────────────────
  const edges: CrossAppEdge[] = [...edgeMap.entries()].map(([key, e]) => {
    const reverseKey = `${e.target}→${e.source}`;
    const wasPair = dropped.has(reverseKey);
    const isBidirectional = wasPair && e.confident;
    const direction: EdgeDirection = isBidirectional
      ? 'bidirectional'
      : e.confident ? 'unidirectional' : 'uncertain';

    return {
      id: key,
      source: e.source,
      target: e.target,
      type: 'crossAppEdge' as const,
      animated: direction === 'uncertain',
      data: {
        msgTypes: e.msgTypes,
        interfaces: e.interfaces,
        transport: e.transport,
        direction,
        confident: e.confident,
      },
    };
  });

  return { nodes: [...nodeMap.values()], edges };
}
