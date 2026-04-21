import { describe, it, expect } from 'vitest';
import { extractMessageInterfaces } from '../messagingExtractor';
import type { CDefine, CStruct, FileAnalysis, IpcCall, LoadedFile, MsgStructPattern, TypeDict } from '../types';

function makeTypeDict(defines: CDefine[] = [], structs: CStruct[] = []): TypeDict {
  return { structs, enums: [], defines };
}

function makeAnalysis(
  filename: string,
  defines: CDefine[] = [],
  ipc: IpcCall[] = []
): FileAnalysis {
  return {
    filename,
    role: 'source',
    functions: [],
    externs: [],
    structs: [],
    enums: [],
    defines,
    ipc,
    includes: [],
    risks: [],
    unknownCalls: [],
  };
}

function makeStruct(name: string, sourceFile: string): CStruct {
  return { name, fields: [], sourceFile, conditional: false };
}

function makeSourceFile(filename: string, content: string): LoadedFile {
  return {
    filename,
    content,
    zone: 'string',
    encoding: 'utf-8',
    sizeBytes: content.length,
    oversized: false,
    rejected: false,
  };
}

function makeMsgStructPattern(pattern: string, name = pattern): MsgStructPattern {
  return { id: 'test-' + name, name, pattern };
}

describe('messagingExtractor', () => {
  it('returns empty array when no MSG_TYPE_* defines exist', () => {
    const result = extractMessageInterfaces([makeAnalysis('main.c')], makeTypeDict(), []);
    expect(result).toHaveLength(0);
  });

  it('finds MSG_TYPE_* constants in typeDict', () => {
    const defines: CDefine[] = [
      { name: 'MSG_TYPE_ACOUSTIC', value: '0x01', category: 'protocol', sourceFile: 'types.h', conditional: false },
    ];
    const result = extractMessageInterfaces(
      [makeAnalysis('main.c')],
      makeTypeDict(defines),
      []
    );
    expect(result).toHaveLength(1);
    expect(result[0].msgTypeConstant).toBe('MSG_TYPE_ACOUSTIC');
    expect(result[0].msgTypeValue).toBe('0x01');
  });

  it('does not match CMD_* by default (too broad)', () => {
    const defines: CDefine[] = [
      { name: 'CMD_FIRE', value: '5', category: 'protocol', sourceFile: 'cmds.h', conditional: false },
    ];
    const result = extractMessageInterfaces(
      [makeAnalysis('main.c')],
      makeTypeDict(defines),
      []
    );
    expect(result.some((m) => m.msgTypeConstant === 'CMD_FIRE')).toBe(false);
  });

  it('matches CMD_* when added as a custom pattern', () => {
    const defines: CDefine[] = [
      { name: 'CMD_FIRE', value: '5', category: 'protocol', sourceFile: 'cmds.h', conditional: false },
    ];
    const customPatterns = [{ id: '1', name: 'CMD_*', pattern: '^CMD_', ipcType: 'custom' as const, direction: 'bidirectional' as const, notes: '' }];
    const result = extractMessageInterfaces(
      [makeAnalysis('main.c')],
      makeTypeDict(defines),
      customPatterns
    );
    expect(result.some((m) => m.msgTypeConstant === 'CMD_FIRE')).toBe(true);
  });

  it('sets structResolved false when no matching struct found', () => {
    const defines: CDefine[] = [
      { name: 'MSG_TYPE_FOO', value: '1', category: 'protocol', sourceFile: 'foo.h', conditional: false },
    ];
    const result = extractMessageInterfaces(
      [makeAnalysis('main.c')],
      makeTypeDict(defines),
      []
    );
    expect(result[0].structResolved).toBe(false);
    expect(result[0].struct).toBeNull();
  });
});

describe('messagingExtractor — struct patterns', () => {
  it('returns empty when struct pattern matches nothing in typeDict', () => {
    const result = extractMessageInterfaces(
      [makeAnalysis('main.c')],
      makeTypeDict(),
      [],
      [],
      [makeMsgStructPattern('_DATA$')]
    );
    expect(result).toHaveLength(0);
  });

  it('creates a MessageInterface with structResolved=true for matched struct', () => {
    const struct = makeStruct('SONAR_DATA', 'sonar.h');
    const result = extractMessageInterfaces(
      [makeAnalysis('main.c')],
      makeTypeDict([], [struct]),
      [],
      [],
      [makeMsgStructPattern('_DATA$')]
    );
    expect(result).toHaveLength(1);
    expect(result[0].msgTypeConstant).toBe('SONAR_DATA');
    expect(result[0].structResolved).toBe(true);
    expect(result[0].struct).toBe(struct);
    expect(result[0].msgTypeValue).toBe('(struct)');
    expect(result[0].definedIn).toBe('sonar.h');
  });

  it('populates fileRoles from source files that reference the struct', () => {
    const struct = makeStruct('SONAR_DATA', 'sonar.h');
    const analyses = [
      makeAnalysis('sender.c', [], [{ type: 'socket-send', detail: 'send(sock, &msg, sizeof(msg), 0)' }]),
      makeAnalysis('receiver.c', [], [{ type: 'socket-recv', detail: 'recv(sock, &buf, sizeof(buf), 0)' }]),
    ];
    const sourceFiles = [
      makeSourceFile('sender.c', 'SONAR_DATA msg; send(sock, &msg, sizeof(msg), 0);'),
      makeSourceFile('receiver.c', 'SONAR_DATA buf; recv(sock, &buf, sizeof(buf), 0);'),
    ];
    const result = extractMessageInterfaces(
      analyses,
      makeTypeDict([], [struct]),
      [],
      sourceFiles,
      [makeMsgStructPattern('_DATA$')]
    );
    expect(result).toHaveLength(1);
    const roles = result[0].fileRoles;
    expect(roles.find((r) => r.filename === 'sender.c')?.role).toBe('producer');
    expect(roles.find((r) => r.filename === 'receiver.c')?.role).toBe('consumer');
  });

  it('handles invalid regex pattern gracefully — skips it, does not throw', () => {
    const struct = makeStruct('SONAR_DATA', 'sonar.h');
    expect(() =>
      extractMessageInterfaces(
        [makeAnalysis('main.c')],
        makeTypeDict([], [struct]),
        [],
        [],
        [makeMsgStructPattern('[invalid(regex')]
      )
    ).not.toThrow();
  });

  it('deduplicates when two patterns match the same struct', () => {
    const struct = makeStruct('SONAR_DATA', 'sonar.h');
    const result = extractMessageInterfaces(
      [makeAnalysis('main.c')],
      makeTypeDict([], [struct]),
      [],
      [],
      [makeMsgStructPattern('SONAR_DATA'), makeMsgStructPattern('_DATA$')]
    );
    expect(result).toHaveLength(1);
  });

  it('falls back to role "both" when source file uses a wrapper IPC function with no direction info', () => {
    const struct = makeStruct('SONAR_DATA', 'sonar.h');
    const analyses = [
      makeAnalysis('sender.c', [], [{ type: 'custom', detail: 'ipc_dispatch(handle, &msg)' }]),
      makeAnalysis('receiver.c', [], [{ type: 'custom', detail: 'ipc_receive(handle, &buf)' }]),
    ];
    const sourceFiles = [
      makeSourceFile('sender.c', 'SONAR_DATA msg; ipc_dispatch(handle, &msg);'),
      makeSourceFile('receiver.c', 'SONAR_DATA buf; ipc_receive(handle, &buf);'),
    ];
    const result = extractMessageInterfaces(
      analyses,
      makeTypeDict([], [struct]),
      [],
      sourceFiles,
      [makeMsgStructPattern('_DATA$')]
    );
    expect(result).toHaveLength(1);
    const roles = result[0].fileRoles;
    // Both files should be included with role 'both' (indeterminate — no explicit direction)
    expect(roles).toHaveLength(2);
    expect(roles.every((r) => r.role === 'both')).toBe(true);
  });

  it('resolves producer role from custom pattern with direction "send"', () => {
    const struct = makeStruct('SONAR_DATA', 'sonar.h');
    const analyses = [
      makeAnalysis('sender.c', [], [{ type: 'custom', detail: 'ipc_dispatch (custom pattern, 1 match)', direction: 'send' }]),
      makeAnalysis('receiver.c', [], [{ type: 'custom', detail: 'ipc_receive (custom pattern, 1 match)', direction: 'recv' }]),
    ];
    const sourceFiles = [
      makeSourceFile('sender.c', 'SONAR_DATA msg; ipc_dispatch(handle, &msg);'),
      makeSourceFile('receiver.c', 'SONAR_DATA buf; ipc_receive(handle, &buf);'),
    ];
    const result = extractMessageInterfaces(
      analyses,
      makeTypeDict([], [struct]),
      [],
      sourceFiles,
      [makeMsgStructPattern('_DATA$')]
    );
    expect(result).toHaveLength(1);
    const roles = result[0].fileRoles;
    expect(roles.find((r) => r.filename === 'sender.c')?.role).toBe('producer');
    expect(roles.find((r) => r.filename === 'receiver.c')?.role).toBe('consumer');
    expect(result[0].directionConfident).toBe(true);
  });

  it('resolves "both" role from custom pattern with direction "bidirectional"', () => {
    const struct = makeStruct('SONAR_DATA', 'sonar.h');
    const analyses = [
      makeAnalysis('nodeA.c', [], [{ type: 'custom', detail: 'ipc_exchange (custom pattern, 1 match)', direction: 'bidirectional' }]),
      makeAnalysis('nodeB.c', [], [{ type: 'custom', detail: 'ipc_exchange (custom pattern, 1 match)', direction: 'bidirectional' }]),
    ];
    const sourceFiles = [
      makeSourceFile('nodeA.c', 'SONAR_DATA msg; ipc_exchange(handle, &msg);'),
      makeSourceFile('nodeB.c', 'SONAR_DATA msg; ipc_exchange(handle, &msg);'),
    ];
    const result = extractMessageInterfaces(
      analyses,
      makeTypeDict([], [struct]),
      [],
      sourceFiles,
      [makeMsgStructPattern('_DATA$')]
    );
    expect(result).toHaveLength(1);
    const roles = result[0].fileRoles;
    expect(roles.find((r) => r.filename === 'nodeA.c')?.role).toBe('both');
    expect(roles.find((r) => r.filename === 'nodeB.c')?.role).toBe('both');
    expect(result[0].directionConfident).toBe(true);
  });

  it('produces single-entry fileRoles when struct is referenced in only one source file', () => {
    const struct = makeStruct('SONAR_DATA', 'sonar.h');
    const analyses = [makeAnalysis('solo.c', [], [{ type: 'socket-send', detail: 'send(s, &m, n, 0)' }])];
    const sourceFiles = [makeSourceFile('solo.c', 'SONAR_DATA m; send(s, &m, n, 0);')];
    const result = extractMessageInterfaces(
      analyses,
      makeTypeDict([], [struct]),
      [],
      sourceFiles,
      [makeMsgStructPattern('_DATA$')]
    );
    expect(result).toHaveLength(1);
    expect(result[0].fileRoles).toHaveLength(1);
    expect(result[0].fileRoles[0].filename).toBe('solo.c');
  });

  it('does not duplicate when struct name also exists as a define-based entry, define wins', () => {
    // Hypothetical: a define named SONAR_DATA (unlikely but must be handled)
    const struct = makeStruct('SONAR_DATA', 'sonar.h');
    const defines: CDefine[] = [
      { name: 'SONAR_DATA', value: '1', category: 'protocol', sourceFile: 'sonar.h', conditional: false },
    ];
    const customPatterns = [{ id: '1', name: 'SONAR_DATA', pattern: '^SONAR_DATA$', ipcType: 'custom' as const, direction: 'bidirectional' as const, notes: '' }];
    const result = extractMessageInterfaces(
      [makeAnalysis('main.c')],
      makeTypeDict(defines, [struct]),
      customPatterns,
      [],
      [makeMsgStructPattern('^SONAR_DATA$')]
    );
    // define-based entry wins; struct-based is filtered out
    const matches = result.filter((m) => m.msgTypeConstant === 'SONAR_DATA');
    expect(matches).toHaveLength(1);
    expect(matches[0].msgTypeValue).not.toBe('(struct)'); // came from define, not struct path
  });
});

// ── Strategy A: IpcCall.msgConstants ─────────────────────────────────────────

describe('messagingExtractor — Strategy A (IPC call argument constants)', () => {
  it('creates MessageInterface for a non-standard constant found in IpcCall.msgConstants', () => {
    // SLEMR_MSG_SONAR has no MSG_TYPE_ prefix — would be missed by normal define scanning
    const defines: CDefine[] = [
      { name: 'SLEMR_MSG_SONAR', value: '0x10', category: 'protocol', sourceFile: 'slemr.h', conditional: false },
    ];
    const analyses = [
      makeAnalysis('sonar.c', [], [{
        type: 'custom', detail: 'slemr_send (custom pattern, 1 match)',
        direction: 'send', msgConstants: ['SLEMR_MSG_SONAR'],
      }]),
    ];
    const result = extractMessageInterfaces(analyses, makeTypeDict(defines), []);
    const iface = result.find((m) => m.msgTypeConstant === 'SLEMR_MSG_SONAR');
    expect(iface).toBeDefined();
    expect(iface!.msgTypeValue).toBe('0x10');
    expect(iface!.direction).toBe('producer');
    expect(iface!.directionConfident).toBe(true);
    expect(iface!.transport).toBe('custom');
  });

  it('resolves struct from msgConstant via candidateStructNames when name matches a candidate', () => {
    // candidateStructNames strips MSG_TYPE_ prefix: MSG_TYPE_SONAR → Sonar, SonarMsg, ...
    const defines: CDefine[] = [
      { name: 'MSG_TYPE_SONAR', value: '0x10', category: 'protocol', sourceFile: 'slemr.h', conditional: false },
    ];
    const struct = makeStruct('SonarMsg', 'slemr.h');
    const analyses = [
      makeAnalysis('sonar.c', [], [{
        type: 'custom', detail: 'slemr_send (custom pattern, 1 match)',
        direction: 'send', msgConstants: ['MSG_TYPE_SONAR'],
      }]),
    ];
    const result = extractMessageInterfaces(analyses, makeTypeDict(defines, [struct]), []);
    const iface = result.find((m) => m.msgTypeConstant === 'MSG_TYPE_SONAR');
    // MSG_TYPE_SONAR → Sonar → SonarMsg is a candidate
    expect(iface?.struct?.name).toBe('SonarMsg');
    expect(iface?.structResolved).toBe(true);
  });

  it('leaves struct unresolved for non-standard prefix constants with no matching candidate', () => {
    // SLEMR_MSG_SONAR → candidates: SlemrMsgSonar, SlemrMsgSonarMsg, ... — unlikely to match
    const defines: CDefine[] = [
      { name: 'SLEMR_MSG_SONAR', value: '0x10', category: 'protocol', sourceFile: 'slemr.h', conditional: false },
    ];
    const analyses = [
      makeAnalysis('sonar.c', [], [{
        type: 'custom', detail: 'slemr_send (custom pattern, 1 match)',
        direction: 'send', msgConstants: ['SLEMR_MSG_SONAR'],
      }]),
    ];
    const result = extractMessageInterfaces(analyses, makeTypeDict(defines), []);
    const iface = result.find((m) => m.msgTypeConstant === 'SLEMR_MSG_SONAR');
    expect(iface).toBeDefined();
    expect(iface!.structResolved).toBe(false); // no matching struct — Strategy B needed
    expect(iface!.msgTypeValue).toBe('0x10');  // define value still present
  });

  it('creates stub entry with "(definition not found)" for missingConstants', () => {
    const analyses = [
      makeAnalysis('sender.c', [], [{
        type: 'custom', detail: 'slemr_send (custom pattern, 1 match)',
        direction: 'send', missingConstants: ['UNDEFINED_MSG'],
      }]),
    ];
    const result = extractMessageInterfaces(analyses, makeTypeDict(), []);
    const iface = result.find((m) => m.msgTypeConstant === 'UNDEFINED_MSG');
    expect(iface).toBeDefined();
    expect(iface!.msgTypeValue).toBe('(definition not found)');
    expect(iface!.struct).toBeNull();
    expect(iface!.structResolved).toBe(false);
    expect(iface!.direction).toBe('producer');
  });

  it('augments existing define-based interface direction when was unknown', () => {
    const defines: CDefine[] = [
      { name: 'MSG_TYPE_ACOUSTIC', value: '0x01', category: 'protocol', sourceFile: 'types.h', conditional: false },
    ];
    // No source files → findReferences returns empty → direction unknown
    const analyses = [
      makeAnalysis('wrapper.c', [], [{
        type: 'custom', detail: 'slemr_send (custom pattern, 1 match)',
        direction: 'send', msgConstants: ['MSG_TYPE_ACOUSTIC'],
      }]),
    ];
    const result = extractMessageInterfaces(analyses, makeTypeDict(defines), []);
    const iface = result.find((m) => m.msgTypeConstant === 'MSG_TYPE_ACOUSTIC');
    expect(iface).toBeDefined();
    expect(iface!.directionConfident).toBe(true);
    expect(iface!.direction).toBe('producer');
  });

  it('merges producer + consumer fileRoles across files for same constant', () => {
    const defines: CDefine[] = [
      { name: 'SLEMR_MSG_TRACK', value: '0x11', category: 'protocol', sourceFile: 'slemr.h', conditional: false },
    ];
    const analyses = [
      makeAnalysis('producer.c', [], [{
        type: 'custom', detail: 'slemr_send (custom pattern, 1 match)',
        direction: 'send', msgConstants: ['SLEMR_MSG_TRACK'],
      }]),
      makeAnalysis('consumer.c', [], [{
        type: 'custom', detail: 'slemr_recv (custom pattern, 1 match)',
        direction: 'recv', msgConstants: ['SLEMR_MSG_TRACK'],
      }]),
    ];
    const result = extractMessageInterfaces(analyses, makeTypeDict(defines), []);
    const matches = result.filter((m) => m.msgTypeConstant === 'SLEMR_MSG_TRACK');
    expect(matches).toHaveLength(1);
    const roles = matches[0].fileRoles;
    expect(roles.find((r) => r.filename === 'producer.c')?.role).toBe('producer');
    expect(roles.find((r) => r.filename === 'consumer.c')?.role).toBe('consumer');
    expect(matches[0].direction).toBe('both');
  });

  it('does not duplicate when constant also appears in define-based set', () => {
    const defines: CDefine[] = [
      { name: 'MSG_TYPE_STATUS', value: '0x02', category: 'protocol', sourceFile: 'types.h', conditional: false },
    ];
    const analyses = [
      makeAnalysis('a.c', [], [{
        type: 'custom', detail: 'slemr_send (custom pattern, 1 match)',
        direction: 'send', msgConstants: ['MSG_TYPE_STATUS'],
      }]),
    ];
    const result = extractMessageInterfaces(analyses, makeTypeDict(defines), []);
    const matches = result.filter((m) => m.msgTypeConstant === 'MSG_TYPE_STATUS');
    expect(matches).toHaveLength(1);
  });
});

// ── Strategy B: IpcCall.impliedStructs ────────────────────────────────────────

describe('messagingExtractor — Strategy B (wrapper function implied structs)', () => {
  it('creates MessageInterface with structResolved=true from impliedStructs', () => {
    const struct = makeStruct('SonarPingData', 'slemr.h');
    const analyses = [
      makeAnalysis('sonar_wrapper.c', [], [{
        type: 'custom', detail: 'slemr_send (custom pattern, 1 match)',
        direction: 'send', impliedStructs: ['SonarPingData'],
      }]),
    ];
    const result = extractMessageInterfaces(analyses, makeTypeDict([], [struct]), []);
    const iface = result.find((m) => m.msgTypeConstant === 'SonarPingData');
    expect(iface).toBeDefined();
    expect(iface!.struct).toBe(struct);
    expect(iface!.structResolved).toBe(true);
    expect(iface!.msgTypeValue).toBe('(implied from wrapper)');
    expect(iface!.direction).toBe('producer');
    expect(iface!.directionConfident).toBe(true);
  });

  it('silently skips when implied struct is not in typeDict', () => {
    const analyses = [
      makeAnalysis('x.c', [], [{
        type: 'custom', detail: 'slemr_send (custom pattern, 1 match)',
        direction: 'send', impliedStructs: ['NonExistentStruct'],
      }]),
    ];
    const result = extractMessageInterfaces(analyses, makeTypeDict(), []);
    expect(result.find((m) => m.msgTypeConstant === 'NonExistentStruct')).toBeUndefined();
  });

  it('does not duplicate when implied struct name already covered by Strategy A', () => {
    const defines: CDefine[] = [
      { name: 'SonarPingData', value: '0x10', category: 'other', sourceFile: 'slemr.h', conditional: false },
    ];
    const struct = makeStruct('SonarPingData', 'slemr.h');
    const analyses = [
      makeAnalysis('a.c', [], [{
        type: 'custom', detail: 'slemr_send (custom pattern, 1 match)',
        direction: 'send', msgConstants: ['SonarPingData'], impliedStructs: ['SonarPingData'],
      }]),
    ];
    const result = extractMessageInterfaces(analyses, makeTypeDict(defines, [struct]), []);
    const matches = result.filter((m) => m.msgTypeConstant === 'SonarPingData');
    expect(matches).toHaveLength(1);
  });

  it('sets recv direction from consumer-side wrapper', () => {
    const struct = makeStruct('TargetTrackData', 'slemr.h');
    const analyses = [
      makeAnalysis('consumer.c', [], [{
        type: 'custom', detail: 'slemr_recv (custom pattern, 1 match)',
        direction: 'recv', impliedStructs: ['TargetTrackData'],
      }]),
    ];
    const result = extractMessageInterfaces(analyses, makeTypeDict([], [struct]), []);
    const iface = result.find((m) => m.msgTypeConstant === 'TargetTrackData');
    expect(iface?.direction).toBe('consumer');
    expect(iface?.fileRoles[0].role).toBe('consumer');
  });

  it('sets both direction when producer and consumer wrappers found in different files', () => {
    const struct = makeStruct('WeaponsData', 'slemr.h');
    const analyses = [
      makeAnalysis('sender.c', [], [{
        type: 'custom', detail: 'slemr_send (custom pattern, 1 match)',
        direction: 'send', impliedStructs: ['WeaponsData'],
      }]),
      makeAnalysis('receiver.c', [], [{
        type: 'custom', detail: 'slemr_recv (custom pattern, 1 match)',
        direction: 'recv', impliedStructs: ['WeaponsData'],
      }]),
    ];
    const result = extractMessageInterfaces(analyses, makeTypeDict([], [struct]), []);
    const matches = result.filter((m) => m.msgTypeConstant === 'WeaponsData');
    expect(matches).toHaveLength(1);
    expect(matches[0].direction).toBe('both');
  });
});
