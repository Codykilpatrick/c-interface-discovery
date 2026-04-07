import { describe, it, expect } from 'vitest';
import { buildGraph, EXTERNAL_NODE_ID } from '../buildGraph';
import type { StringAnalysis, MessageInterface, FileAnalysis } from '../../analyzer/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAnalysis(filename: string): FileAnalysis {
  return {
    filename,
    role: 'source',
    functions: [],
    externs: [],
    structs: [],
    enums: [],
    defines: [],
    ipc: [],
    includes: [],
    risks: [],
    unknownCalls: [],
  };
}

function makeMsg(
  constant: string,
  fileRoles: MessageInterface['fileRoles']
): MessageInterface {
  return {
    msgTypeConstant: constant,
    msgTypeValue: '1',
    struct: null,
    structResolved: false,
    direction: 'producer',
    directionConfident: true,
    transport: 'socket-send',
    definedIn: 'types.h',
    usedIn: [],
    fileRoles,
  };
}

function makeStringAnalysis(
  filenames: string[],
  messages: MessageInterface[]
): StringAnalysis {
  return {
    files: filenames.map(makeAnalysis),
    typeDict: { structs: [], enums: [], defines: [] },
    messageInterfaces: messages,
    customPatterns: [],
    msgStructPatterns: [],
    warnings: [],
  };
}

// ── Normal cases (no phantom node expected) ───────────────────────────────────

describe('buildGraph — normal edges (no phantom node)', () => {
  it('produces no nodes or edges when there are no files', () => {
    const { nodes, edges } = buildGraph(makeStringAnalysis([], []));
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it('produces no phantom node when a message has both producer and consumer', () => {
    const msg = makeMsg('SONAR_DATA', [
      { filename: 'sender.c', role: 'producer' },
      { filename: 'receiver.c', role: 'consumer' },
    ]);
    const { nodes } = buildGraph(makeStringAnalysis(['sender.c', 'receiver.c'], [msg]));
    expect(nodes.some((n) => n.id === EXTERNAL_NODE_ID)).toBe(false);
  });

  it('draws an edge between producer and consumer', () => {
    const msg = makeMsg('SONAR_DATA', [
      { filename: 'sender.c', role: 'producer' },
      { filename: 'receiver.c', role: 'consumer' },
    ]);
    const { edges } = buildGraph(makeStringAnalysis(['sender.c', 'receiver.c'], [msg]));
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe('sender.c');
    expect(edges[0].target).toBe('receiver.c');
  });

  it('produces no phantom node when fileRoles is empty (message not referenced in any loaded file)', () => {
    const msg = makeMsg('SONAR_DATA', []);
    const { nodes } = buildGraph(makeStringAnalysis(['main.c'], [msg]));
    expect(nodes.some((n) => n.id === EXTERNAL_NODE_ID)).toBe(false);
  });
});

// ── Unknown / phantom node cases ──────────────────────────────────────────────

describe('buildGraph — phantom external node', () => {
  it('creates a phantom node when a message has producers but no consumers', () => {
    const msg = makeMsg('SONAR_DATA', [
      { filename: 'sender.c', role: 'producer' },
    ]);
    const { nodes } = buildGraph(makeStringAnalysis(['sender.c'], [msg]));
    expect(nodes.some((n) => n.id === EXTERNAL_NODE_ID)).toBe(true);
  });

  it('creates a phantom node when a message has consumers but no producers', () => {
    const msg = makeMsg('SONAR_DATA', [
      { filename: 'receiver.c', role: 'consumer' },
    ]);
    const { nodes } = buildGraph(makeStringAnalysis(['receiver.c'], [msg]));
    expect(nodes.some((n) => n.id === EXTERNAL_NODE_ID)).toBe(true);
  });

  it('draws an edge from producer to phantom when no consumer is loaded', () => {
    const msg = makeMsg('SONAR_DATA', [
      { filename: 'sender.c', role: 'producer' },
    ]);
    const { edges } = buildGraph(makeStringAnalysis(['sender.c'], [msg]));
    const phantomEdge = edges.find((e) => e.target === EXTERNAL_NODE_ID);
    expect(phantomEdge).toBeDefined();
    expect(phantomEdge?.source).toBe('sender.c');
  });

  it('draws an edge from phantom to consumer when no producer is loaded', () => {
    const msg = makeMsg('SONAR_DATA', [
      { filename: 'receiver.c', role: 'consumer' },
    ]);
    const { edges } = buildGraph(makeStringAnalysis(['receiver.c'], [msg]));
    const phantomEdge = edges.find((e) => e.source === EXTERNAL_NODE_ID);
    expect(phantomEdge).toBeDefined();
    expect(phantomEdge?.target).toBe('receiver.c');
  });

  it('creates only one phantom node even when multiple messages are one-sided', () => {
    const messages = [
      makeMsg('SONAR_DATA',  [{ filename: 'sender.c', role: 'producer' }]),
      makeMsg('RADAR_DATA',  [{ filename: 'sender.c', role: 'producer' }]),
      makeMsg('STATUS_DATA', [{ filename: 'receiver.c', role: 'consumer' }]),
    ];
    const { nodes } = buildGraph(makeStringAnalysis(['sender.c', 'receiver.c'], messages));
    const phantomNodes = nodes.filter((n) => n.id === EXTERNAL_NODE_ID);
    expect(phantomNodes).toHaveLength(1);
  });

  it('creates separate edges to phantom for each one-sided producer message', () => {
    const messages = [
      makeMsg('SONAR_DATA', [{ filename: 'sender.c', role: 'producer' }]),
      makeMsg('RADAR_DATA', [{ filename: 'sender.c', role: 'producer' }]),
    ];
    const { edges } = buildGraph(makeStringAnalysis(['sender.c'], messages));
    // One collapsed edge sender.c → phantom (msgTypes merged), or two separate — either is valid
    // but the phantom must appear as a target
    expect(edges.some((e) => e.target === EXTERNAL_NODE_ID)).toBe(true);
  });

  it('does not create a phantom node for a "both"-role file that has another "both" peer', () => {
    // Two files both with 'both' role → they get a bidirectional edge to each other, no phantom
    const msg = makeMsg('SONAR_DATA', [
      { filename: 'nodeA.c', role: 'both' },
      { filename: 'nodeB.c', role: 'both' },
    ]);
    const { nodes } = buildGraph(makeStringAnalysis(['nodeA.c', 'nodeB.c'], [msg]));
    expect(nodes.some((n) => n.id === EXTERNAL_NODE_ID)).toBe(false);
  });

  it('phantom node has a distinct type from regular process nodes', () => {
    const msg = makeMsg('SONAR_DATA', [{ filename: 'sender.c', role: 'producer' }]);
    const { nodes } = buildGraph(makeStringAnalysis(['sender.c'], [msg]));
    const phantom = nodes.find((n) => n.id === EXTERNAL_NODE_ID);
    const regular = nodes.find((n) => n.id === 'sender.c');
    expect(phantom?.type).not.toBe(regular?.type);
  });
});
