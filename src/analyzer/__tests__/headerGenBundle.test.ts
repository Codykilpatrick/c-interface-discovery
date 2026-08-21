import { describe, it, expect } from 'vitest';
import {
  buildHeaderGenBundle,
  extractIncludes,
  resolveInclude,
} from '../headerGenBundle';
import type { CStruct, FileAnalysis, LoadedFile, MessageInterface, TypeDict } from '../types';
import type { PayloadResolution } from '../payloadResolver';

function file(filename: string, content: string): LoadedFile {
  return {
    filename,
    content,
    zone: filename.endsWith('.c') ? 'string' : 'external',
    encoding: 'utf-8',
    sizeBytes: content.length,
    oversized: false,
    rejected: false,
  };
}

function struct(name: string, sourceFile: string, fields: { type: string; name: string }[] = []): CStruct {
  return { name, fields, sourceFile, conditional: false };
}

function msg(structType: CStruct): MessageInterface {
  return {
    msgTypeConstant: `MSG_${structType.name.toUpperCase()}`,
    msgTypeValue: '1',
    struct: structType,
    structResolved: true,
    direction: 'producer',
    directionConfident: true,
    transport: 'custom',
    definedIn: structType.sourceFile,
    usedIn: [],
    fileRoles: [],
  };
}

function payload(structType: CStruct, confidence: PayloadResolution['confidence'] = 'high'): PayloadResolution {
  return {
    sendSiteFile: 'app/main.c',
    sendSiteLine: 10,
    sendSiteText: 'send()',
    patternName: 'send',
    resolvedStructName: structType.name,
    resolvedStruct: structType,
    msgIdConstant: null,
    msgIdValue: null,
    confidence,
    strategy: 'address-of',
    notes: '',
  };
}

describe('extractIncludes / resolveInclude', () => {
  it('extracts quoted and system includes', () => {
    const incs = extractIncludes('#include "local.h"\n#include <stdio.h>\n');
    expect(incs).toEqual([
      { path: 'local.h', isLocal: true },
      { path: 'stdio.h', isLocal: false },
    ]);
  });

  it('resolves a sibling include first', () => {
    const hit = resolveInclude('sa/msg.h', 'types.h', ['sa/types.h', 'common/types.h']);
    expect(hit.file).toBe('sa/types.h');
  });

  it('reports ambiguous basename matches', () => {
    const hit = resolveInclude('app/main.c', 'types.h', ['sa/types.h', 'common/types.h']);
    expect(hit.file).toBeUndefined();
    expect(hit.ambiguous).toEqual(['sa/types.h', 'common/types.h']);
  });
});

describe('buildHeaderGenBundle', () => {
  const acoustic = struct('AcousticMsg', 'sa/acoustic_msg.h', [
    { type: 'AcousticSample', name: 'sample' },
    { type: 'int', name: 'seq' },
  ]);
  const command = struct('CommandMsg', 'sa/command_msg.h', [
    { type: 'int', name: 'cmd' },
  ]);
  const sample = struct('AcousticSample', 'common/sensor_types.h', [
    { type: 'float', name: 'level' },
  ]);
  const unused = struct('UnusedMsg', 'unused/dead.h', []);

  const typeDict: TypeDict = {
    structs: [acoustic, command, sample, unused],
    enums: [],
    defines: [],
  };

  const files = [
    file('app/main.c', '#include "sa/acoustic_msg.h"\n#include "sa/command_msg.h"\n'),
    file('sa/acoustic_msg.h', '#include "sensor_types.h"\n#include "legacy_macros.h"\nstruct AcousticMsg { AcousticSample sample; int seq; };\n'),
    file('sa/command_msg.h', 'struct CommandMsg { int cmd; };\n'),
    file('common/sensor_types.h', 'struct AcousticSample { float level; };\n'),
    file('shared/legacy_macros.h', '#define LEGACY 1\n'),
    file('unused/dead.h', 'struct UnusedMsg { int x; };\n'),
  ];

  it('uses one root per top-level type and walks downward', () => {
    const bundle = buildHeaderGenBundle({
      messageInterfaces: [msg(acoustic), msg(command)],
      payloadResolutions: [],
      typeDict,
      files,
    });

    expect(bundle.root).toEqual(['sa/acoustic_msg.h', 'sa/command_msg.h']);
    expect(bundle.input).toEqual(['common/sensor_types.h', 'sa/acoustic_msg.h', 'sa/command_msg.h']);
    expect(bundle.include).toEqual(['shared/legacy_macros.h']);
    expect(bundle.includeDirs).toEqual(['common', 'sa', 'shared']);
    expect(bundle.input).not.toContain('unused/dead.h');
    expect(bundle.root).not.toContain('common/sensor_types.h');

    const sampleType = bundle.types.find((t) => t.name === 'AcousticSample');
    expect(sampleType?.reachedFrom).toEqual(['sa/acoustic_msg.h']);
    const cmdType = bundle.types.find((t) => t.name === 'CommandMsg');
    expect(cmdType?.reachedFrom).toEqual(['sa/command_msg.h']);
  });

  it('seeds roots from high-confidence payload resolutions', () => {
    const bundle = buildHeaderGenBundle({
      messageInterfaces: [],
      payloadResolutions: [payload(command)],
      typeDict,
      files: [file('app/main.c', 'send();\n'), file('sa/command_msg.h', 'struct CommandMsg { int cmd; };\n')],
    });
    expect(bundle.root).toEqual(['sa/command_msg.h']);
    expect(bundle.input).toEqual(['sa/command_msg.h']);
  });

  it('seeds a root from a struct used in two source files without Detect', () => {
    const config = struct('SensorConfig', 'sa/sensor_defs.h', [{ type: 'int', name: 'id' }]);
    const bundle = buildHeaderGenBundle({
      messageInterfaces: [],
      payloadResolutions: [],
      typeDict: { structs: [config, unused], enums: [], defines: [] },
      files: [
        file('app/a.c', 'SensorConfig cfg;\n'),
        file('app/b.c', 'void f(SensorConfig *c);\n'),
        file('sa/sensor_defs.h', 'typedef struct { int id; } SensorConfig;\n'),
        file('unused/dead.h', 'struct UnusedMsg { int x; };\n'),
      ],
    });
    expect(bundle.root).toEqual(['sa/sensor_defs.h']);
    expect(bundle.input).toEqual(['sa/sensor_defs.h']);
    expect(bundle.root).not.toContain('unused/dead.h');
  });

  it('seeds a root from impliedStructs on an IPC call', () => {
    const analysis: FileAnalysis = {
      filename: 'app/main.c',
      role: 'source',
      functions: [],
      externs: [],
      structs: [],
      enums: [],
      defines: [],
      ipc: [{ type: 'custom', detail: 'send()', impliedStructs: ['CommandMsg'] }],
      includes: [],
      risks: [],
      unknownCalls: [],
    };
    const bundle = buildHeaderGenBundle({
      messageInterfaces: [],
      payloadResolutions: [],
      typeDict,
      files: [file('app/main.c', 'send();\n'), file('sa/command_msg.h', 'struct CommandMsg { int cmd; };\n')],
      analyses: [analysis],
    });
    expect(bundle.root).toEqual(['sa/command_msg.h']);
  });

  it('seeds a root from a header the .c files include', () => {
    const bundle = buildHeaderGenBundle({
      messageInterfaces: [],
      payloadResolutions: [],
      typeDict,
      files: [
        file('sa/main.c', '#include "command_msg.h"\n'),
        file('sa/command_msg.h', 'struct CommandMsg { int cmd; };\n'),
      ],
    });
    expect(bundle.root).toEqual(['sa/command_msg.h']);
  });

  it('reports a missing header that the .c files include', () => {
    const bundle = buildHeaderGenBundle({
      messageInterfaces: [],
      payloadResolutions: [],
      typeDict: { structs: [], enums: [], defines: [] },
      files: [file('synthetic-wcs/weapons_director.c', '#include "wcs_types.h"\n')],
    });
    expect(bundle.root).toEqual([]);
    expect(bundle.review.some((r) =>
      r.kind === 'unresolved-include' && r.message.includes('wcs_types.h')
    )).toBe(true);
  });

  it('does not review an unresolved ID when its header is already input', () => {
    const heartbeat: MessageInterface = {
      ...msg(acoustic),
      msgTypeConstant: 'MSG_TYPE_HEARTBEAT',
      struct: null,
      structResolved: false,
      definedIn: 'sa/acoustic_msg.h',
    };
    const bundle = buildHeaderGenBundle({
      messageInterfaces: [msg(acoustic), heartbeat],
      payloadResolutions: [],
      typeDict,
      files: [
        file('sa/main.c', '#include "acoustic_msg.h"\nMSG_TYPE_HEARTBEAT\nAcousticMsg m;\n'),
        file('sa/acoustic_msg.h', 'struct AcousticMsg { AcousticSample sample; int seq; };\n'),
      ],
    });
    expect(bundle.root).toEqual(['sa/acoustic_msg.h']);
    expect(bundle.review.filter((r) => r.message.includes('HEARTBEAT'))).toEqual([]);
  });

  it('does not seed unused external headers as roots', () => {
    const nav = struct('NavMsg', 'payload-resolution/address-of/types.h', []);
    const bundle = buildHeaderGenBundle({
      messageInterfaces: [msg(acoustic), msg(nav)],
      payloadResolutions: [],
      typeDict: { structs: [acoustic, nav], enums: [], defines: [] },
      files: [
        file('sa/main.c', '#include "acoustic_msg.h"\nAcousticMsg m;\n'),
        file('sa/acoustic_msg.h', 'struct AcousticMsg { AcousticSample sample; int seq; };\n'),
        file('payload-resolution/address-of/types.h', 'typedef struct { float lat; } NavMsg;\n'),
      ],
    });
    expect(bundle.root).toEqual(['sa/acoustic_msg.h']);
    expect(bundle.root).not.toContain('payload-resolution/address-of/types.h');
  });

  it('keeps low-confidence payloads in review, not root', () => {
    const bundle = buildHeaderGenBundle({
      messageInterfaces: [],
      payloadResolutions: [payload(command, 'low')],
      typeDict,
      files: [file('app/main.c', 'send();\n'), file('sa/command_msg.h', 'struct CommandMsg { int cmd; };\n')],
    });
    expect(bundle.root).toEqual([]);
    expect(bundle.review.some((r) => r.kind === 'unresolved-type')).toBe(true);
  });
});
