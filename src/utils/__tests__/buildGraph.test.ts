import { describe, it, expect } from 'vitest';
import { buildGraph } from '../buildGraph';
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

// ── Normal cases ─────────────────────────────────────────────────────────────

describe('buildGraph — normal edges', () => {
  it('produces no nodes or edges when there are no files', () => {
    const { nodes, edges } = buildGraph(makeStringAnalysis([], []));
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it('produces no dangling flag when a message has both producer and consumer', () => {
    const msg = makeMsg('SONAR_DATA', [
      { filename: 'sender.c', role: 'producer' },
      { filename: 'receiver.c', role: 'consumer' },
    ]);
    const { nodes } = buildGraph(makeStringAnalysis(['sender.c', 'receiver.c'], [msg]));
    expect(nodes.every((n) => !n.data.hasDangling)).toBe(true);
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

  it('produces no dangling flag when fileRoles is empty', () => {
    const msg = makeMsg('SONAR_DATA', []);
    const { nodes } = buildGraph(makeStringAnalysis(['main.c'], [msg]));
    expect(nodes.every((n) => !n.data.hasDangling)).toBe(true);
  });
});

// ── Incomplete / dangling message cases ──────────────────────────────────────

describe('buildGraph — incomplete messages (closed-world)', () => {
  it('sets hasDangling on producer file when no consumer is loaded', () => {
    const msg = makeMsg('SONAR_DATA', [
      { filename: 'sender.c', role: 'producer' },
    ]);
    const { nodes } = buildGraph(makeStringAnalysis(['sender.c'], [msg]));
    const sender = nodes.find((n) => n.id === 'sender.c');
    expect(sender?.data.hasDangling).toBe(true);
  });

  it('sets hasDangling on consumer file when no producer is loaded', () => {
    const msg = makeMsg('SONAR_DATA', [
      { filename: 'receiver.c', role: 'consumer' },
    ]);
    const { nodes } = buildGraph(makeStringAnalysis(['receiver.c'], [msg]));
    const receiver = nodes.find((n) => n.id === 'receiver.c');
    expect(receiver?.data.hasDangling).toBe(true);
  });

  it('does not create phantom external nodes for one-sided messages', () => {
    const msg = makeMsg('SONAR_DATA', [
      { filename: 'sender.c', role: 'producer' },
    ]);
    const { nodes } = buildGraph(makeStringAnalysis(['sender.c'], [msg]));
    expect(nodes.every((n) => n.type === 'processNode')).toBe(true);
  });

  it('does not create phantom edges to external nodes', () => {
    const msg = makeMsg('SONAR_DATA', [
      { filename: 'sender.c', role: 'producer' },
    ]);
    const { edges } = buildGraph(makeStringAnalysis(['sender.c'], [msg]));
    expect(edges).toHaveLength(0);
  });

  it('marks incomplete flag on message when producer has no consumer', () => {
    const msg = makeMsg('SONAR_DATA', [
      { filename: 'sender.c', role: 'producer' },
    ]);
    const analysis = makeStringAnalysis(['sender.c'], [msg]);
    buildGraph(analysis);
    expect(analysis.messageInterfaces[0].incomplete).toBe(true);
  });

  it('does not set hasDangling on a file with a fully-connected peer', () => {
    const msg = makeMsg('SONAR_DATA', [
      { filename: 'nodeA.c', role: 'both' },
      { filename: 'nodeB.c', role: 'both' },
    ]);
    const { nodes } = buildGraph(makeStringAnalysis(['nodeA.c', 'nodeB.c'], [msg]));
    expect(nodes.every((n) => !n.data.hasDangling)).toBe(true);
  });
});

// ── Bidirectional edge collapse ───────────────────────────────────────────────

describe('buildGraph — bidirectional edge collapse', () => {
  it('collapses A→B + B→A into a single bidirectional edge', () => {
    const msgAB = makeMsg('MSG_ALPHA', [
      { filename: 'a.c', role: 'producer' },
      { filename: 'b.c', role: 'consumer' },
    ]);
    const msgBA = makeMsg('MSG_BETA', [
      { filename: 'b.c', role: 'producer' },
      { filename: 'a.c', role: 'consumer' },
    ]);
    const { edges } = buildGraph(makeStringAnalysis(['a.c', 'b.c'], [msgAB, msgBA]));
    expect(edges).toHaveLength(1);
    expect(edges[0].data?.direction).toBe('bidirectional');
  });

  it('kept edge contains msgTypes from BOTH directions', () => {
    const msgAB = makeMsg('MSG_ALPHA', [
      { filename: 'a.c', role: 'producer' },
      { filename: 'b.c', role: 'consumer' },
    ]);
    const msgBA = makeMsg('MSG_BETA', [
      { filename: 'b.c', role: 'producer' },
      { filename: 'a.c', role: 'consumer' },
    ]);
    const { edges } = buildGraph(makeStringAnalysis(['a.c', 'b.c'], [msgAB, msgBA]));
    const edge = edges[0];
    expect(edge.data?.msgTypes).toContain('MSG_ALPHA');
    expect(edge.data?.msgTypes).toContain('MSG_BETA');
  });

  it('does not collapse unidirectional edges', () => {
    const msg = makeMsg('MSG_ONE_WAY', [
      { filename: 'a.c', role: 'producer' },
      { filename: 'b.c', role: 'consumer' },
    ]);
    const { edges } = buildGraph(makeStringAnalysis(['a.c', 'b.c'], [msg]));
    expect(edges).toHaveLength(1);
    expect(edges[0].data?.direction).not.toBe('bidirectional');
  });
});
