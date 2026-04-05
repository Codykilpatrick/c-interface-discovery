import { describe, it, expect } from 'vitest';
import { extractMessageInterfaces } from '../messagingExtractor';
import type { CDefine, FileAnalysis, TypeDict } from '../types';

function makeTypeDict(defines: CDefine[] = []): TypeDict {
  return { structs: [], enums: [], defines };
}

function makeAnalysis(filename: string, defines: CDefine[] = []): FileAnalysis {
  return {
    filename,
    role: 'source',
    functions: [],
    externs: [],
    structs: [],
    enums: [],
    defines,
    ipc: [],
    includes: [],
    risks: [],
    unknownCalls: [],
  };
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
