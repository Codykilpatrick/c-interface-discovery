/**
 * A two-application analysis built through the real analyzer passes.
 *
 * Struct roles, layouts and compositions come from `structRoleAnalyzer`,
 * `structLayoutEngine` and `messageComposition` rather than being hand-written,
 * so a digest or tool test cannot pass against numbers the analyzer would never
 * produce. Only the parser is stubbed out — the type dictionary is transcribed.
 */

import { buildStructCatalog } from '../../../analyzer/structLayoutEngine';
import { analyzeStructRoles } from '../../../analyzer/structRoleAnalyzer';
import { buildMessageCompositions } from '../../../analyzer/messageComposition';
import {
  cicTypeDict, cicMessageInterfaces, cicReferencedInSource,
} from '../../../analyzer/__tests__/fixtures/cicTypeDict';
import type {
  ApplicationGroup, FileAnalysis, LoadedFile, MessageInterface, StringAnalysis, TypeDict,
} from '../../../analyzer/types';
import type { PayloadResolution } from '../../../analyzer/payloadResolver';

function file(filename: string, content: string): LoadedFile {
  return {
    filename, content, zone: 'string', encoding: 'utf-8',
    sizeBytes: content.length, oversized: false, rejected: false,
  };
}

function fileAnalysis(filename: string, over: Partial<FileAnalysis> = {}): FileAnalysis {
  return {
    filename, role: 'source', functions: [], externs: [], structs: [], enums: [],
    defines: [], ipc: [], includes: [], risks: [], unknownCalls: [], ...over,
  };
}

const ROUTER_SRC = [
  '#include "cic_protocol.h"',
  'static void route(ContactMsg *m) {',
  '    link11_write(fd, PKT_TYPE_LINK_REPORT, m, sizeof(*m));',
  '    cic_bus_send(bus, MSG_TYPE_CONTACT, sizeof(*m), m);',
  '}',
  'void tick(void) {',
  '    link11_write(fd, PKT_TYPE_LINK_REPORT, 0, 0);',
  '    odd_call(1);',
  '}',
  'void again(void) { link11_write(fd, 0, 0, 0); }',
].join('\n');

/** Build the CIC application: real roles, layouts and compositions. */
export function makeApp(id = 'cic', name = 'CIC'): ApplicationGroup {
  const typeDict: TypeDict = cicTypeDict();
  const base = cicMessageInterfaces(typeDict);

  const messageInterfaces: MessageInterface[] = base.map((m) => ({
    ...m,
    // CIC consumes what Sonar produces, so the cross-app edge is real.
    fileRoles: [{
      filename: 'cic/track_router.c',
      role: m.msgTypeConstant === 'MSG_TYPE_CONTACT'
        ? ('consumer' as const)
        : ('producer' as const),
    }],
    // One uncertain direction and one incomplete pairing, so the unresolved
    // tier has something real to report.
    ...(m.msgTypeConstant === 'MSG_TYPE_TRACK' && {
      direction: 'unknown' as const, directionConfident: false, incomplete: true,
    }),
  }));

  // A message whose struct never resolved.
  messageInterfaces.push({
    msgTypeConstant: 'MSG_TYPE_MYSTERY', msgTypeValue: '0x99', struct: null,
    structResolved: false, direction: 'unknown', directionConfident: false,
    transport: null, definedIn: 'cic/cic_types.h', usedIn: [], fileRoles: [],
  });

  const structCatalog = buildStructCatalog(typeDict, { target: '64bit' });
  const structRoles = analyzeStructRoles({
    typeDict, messageInterfaces, payloadResolutions: [],
    structCatalog, referencedInSource: cicReferencedInSource(),
  });
  const messageCompositions = buildMessageCompositions({
    messageInterfaces, structRoles, typeDict, catalog: structCatalog, target: '64bit',
  });

  const payloadResolutions: PayloadResolution[] = [{
    sendSiteFile: 'cic/track_router.c', sendSiteLine: 41,
    sendSiteText: 'cic_bus_send(bus, id, p, n)', patternName: 'cic_bus_send',
    resolvedStructName: 'SomeStruct', resolvedStruct: null,
    msgIdConstant: null, msgIdValue: null,
    confidence: 'low', strategy: 'pointer', notes: 'traced through a prior assignment',
  }];

  const analysis: StringAnalysis = {
    files: [
      fileAnalysis('cic/track_router.c', {
        unknownCalls: ['link11_write', 'link11_write', 'link11_write', 'odd_call'],
        risks: [{ severity: 'medium', msg: 'sprintf() with unbounded format' }],
        ipc: [{ type: 'socket', detail: 'sendto()' }],
      }),
    ],
    typeDict,
    messageInterfaces,
    customPatterns: [],
    msgStructPatterns: [],
    warnings: [{ kind: 'conflict', message: 'struct TrackMsg defined differently in two files', files: [] }],
    structCatalog,
    structRoles,
    messageCompositions,
    layoutTarget: '64bit',
    payloadResolutions,
    headerGenBundle: {
      root: [], input: [], inputDirs: [], include: [], includeDirs: [], types: [],
      review: [{ kind: 'unresolved-type', message: 'WidgetRef (from cic_types.h): not in type dictionary' }],
    },
  };

  return { id, name, files: [file('cic/track_router.c', ROUTER_SRC)], analysis };
}

/** A second, deliberately small app so cross-app flows have two endpoints. */
export function makeSonarApp(): ApplicationGroup {
  const typeDict: TypeDict = { structs: [], enums: [], defines: [] };
  const messageInterfaces: MessageInterface[] = [
    {
      msgTypeConstant: 'MSG_TYPE_SONAR_FRAME', msgTypeValue: '0x20', struct: null,
      structResolved: false, direction: 'producer', directionConfident: true,
      transport: 'custom', definedIn: 'sonar/sonar_types.h', usedIn: [],
      fileRoles: [{ filename: 'sonar/pub.c', role: 'producer' }],
    },
    {
      // Produced by Sonar, consumed by CIC — a genuine cross-app edge.
      msgTypeConstant: 'MSG_TYPE_CONTACT', msgTypeValue: '0x30', struct: null,
      structResolved: false, direction: 'producer', directionConfident: true,
      transport: 'custom', definedIn: 'common/cic_protocol.h', usedIn: [],
      fileRoles: [{ filename: 'sonar/pub.c', role: 'producer' }],
    },
  ];
  const structCatalog = buildStructCatalog(typeDict, { target: '64bit' });
  const analysis: StringAnalysis = {
    files: [fileAnalysis('sonar/pub.c')],
    typeDict, messageInterfaces, customPatterns: [], msgStructPatterns: [], warnings: [],
    structCatalog,
    structRoles: analyzeStructRoles({
      typeDict, messageInterfaces, payloadResolutions: [],
      structCatalog, referencedInSource: new Set(),
    }),
    messageCompositions: [],
    layoutTarget: '64bit',
  };
  return { id: 'sonar', name: 'Sonar', files: [file('sonar/pub.c', 'void pub(void){}')], analysis };
}

export function makeApps(): ApplicationGroup[] {
  return [makeApp(), makeSonarApp()];
}
