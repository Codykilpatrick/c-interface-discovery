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

  it('falls back to role "both" when source file uses a wrapper IPC function (not in SEND/RECV_CALLS)', () => {
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
    // Both files should be included with role 'both' (indeterminate direction)
    expect(roles).toHaveLength(2);
    expect(roles.every((r) => r.role === 'both')).toBe(true);
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

  it('does not duplicate when struct name also exists as a define-based entry', () => {
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
