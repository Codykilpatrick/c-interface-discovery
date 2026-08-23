import { describe, it, expect } from 'vitest';
import { analyzeStructRoles } from '../structRoleAnalyzer';
import type { StructRole } from '../structRoleAnalyzer';
import { buildStructCatalog } from '../structLayoutEngine';
import type { CStruct, MessageInterface, TypeDict } from '../types';
import type { PayloadResolution } from '../payloadResolver';
import {
  cicTypeDict,
  cicMessageInterfaces,
  cicReferencedInSource,
  CIC_MESSAGES,
} from './fixtures/cicTypeDict';

function runCic(opts: { payloadResolutions?: PayloadResolution[] } = {}) {
  const typeDict = cicTypeDict();
  const messageInterfaces = cicMessageInterfaces(typeDict);
  return analyzeStructRoles({
    typeDict,
    messageInterfaces,
    payloadResolutions: opts.payloadResolutions ?? [],
    structCatalog: buildStructCatalog(typeDict, { target: '64bit' }),
    referencedInSource: cicReferencedInSource(),
  });
}

function roleOf(report: ReturnType<typeof runCic>, name: string): StructRole | undefined {
  return report.byName.get(name)?.role;
}

// ── The acceptance table ──────────────────────────────────────────────────────

describe('structRoleAnalyzer — synthetic-cic acceptance table', () => {
  const report = runCic();

  it('resolves all 8 documented message constants to exactly 8 wire roots', () => {
    expect(report.wireRoots.sort()).toEqual(
      [
        'ContactMsg', 'EngageMsg', 'HeartbeatMsg', 'LinkReportPkt',
        'NavFixMsg', 'OwnShipMsg', 'TrackMsg', 'WeaponOrdMsg',
      ],
    );
    // Every constant the fixture documents is bound to its struct.
    for (const [constant, , structName] of CIC_MESSAGES) {
      expect(report.byName.get(structName)?.boundConstants).toContain(constant);
    }
  });

  it.each([
    ['ContactMsg',      'wire-root'],
    ['OwnShipMsg',      'wire-root'],
    ['WeaponOrdMsg',    'wire-root'],
    ['HeartbeatMsg',    'wire-root'],
    ['LinkReportPkt',   'wire-root'],
    ['NavFixMsg',       'wire-root'],
    ['TrackMsg',        'wire-root-nested'],
    ['EngageMsg',       'wire-root-nested'],
    ['CicHeader',       'envelope'],
    ['PictureTable',    'root-candidate'],
    ['SonarFrame',      'root-candidate'],
    ['FusedContact',    'shared-block'],
    ['TrackKinematics', 'shared-block'],
    ['MotionState',     'shared-block'],
    ['DepthFix',        'shared-block'],
    ['AimSolution',     'block'],
    ['GpsFix',          'block'],
    ['GeoCoord',        'block'],
    ['CicTime',         'block'],
    ['FireDirective',   'orphan'],
    ['SonarContact',    'orphan'],
  ] as [string, StructRole][])('classifies %s as %s', (name, expected) => {
    expect(roleOf(report, name)).toBe(expected);
  });
});

// ── Precedence rule 1: envelope beats binding ─────────────────────────────────

describe('structRoleAnalyzer — envelope precedence', () => {
  it('classifies a header embedded first in many messages as an envelope', () => {
    const report = runCic();
    const hdr = report.byName.get('CicHeader')!;
    expect(hdr.role).toBe('envelope');
    expect(hdr.inDegree).toBe(8);
    expect(hdr.containedBy.every((e) => e.isFirstField)).toBe(true);
    expect(report.envelopes).toEqual(['CicHeader']);
  });

  it('keeps envelope classification even when bound to message constants', () => {
    // The idiom `msg->hdr.msg_type == MSG_TYPE_X` puts a header next to a
    // constant everywhere. A naive classifier promotes it to a message root.
    const typeDict = cicTypeDict();
    const messageInterfaces = cicMessageInterfaces(typeDict);
    const header = typeDict.structs.find((s) => s.name === 'CicHeader')!;
    messageInterfaces.push({
      msgTypeConstant: 'MSG_TYPE_HEARTBEAT',
      msgTypeValue: '0x35',
      struct: header,
      structResolved: true,
      direction: 'producer',
      directionConfident: true,
      transport: 'custom',
      definedIn: 'common/cic_protocol.h',
      usedIn: [],
      fileRoles: [],
    });

    const report = analyzeStructRoles({
      typeDict,
      messageInterfaces,
      payloadResolutions: [],
      referencedInSource: cicReferencedInSource(),
    });
    expect(report.byName.get('CicHeader')?.role).toBe('envelope');
    expect(report.wireRoots).not.toContain('CicHeader');
  });

  it('does not treat a block embedded in only two parents as an envelope', () => {
    // Below ENVELOPE_MIN_PARENTS, even though it is first in both.
    const report = runCic();
    expect(roleOf(report, 'MotionState')).toBe('shared-block');
    expect(report.byName.get('MotionState')?.inDegree).toBe(2);
  });
});

// ── Precedence rule 2: only strong binding promotes ───────────────────────────

describe('structRoleAnalyzer — binding evidence', () => {
  it('does not promote a shared block that is never strongly bound', () => {
    // TrackKinematics sits near MSG_TYPE_ENGAGE in source but is a block in 4
    // parents. Only MessageInterface/PayloadResolution evidence may promote it.
    const report = runCic();
    const tk = report.byName.get('TrackKinematics')!;
    expect(tk.role).toBe('shared-block');
    expect(tk.inDegree).toBe(4);
    expect(tk.boundConstants).toEqual([]);
  });

  it('ignores low and unresolved confidence payload resolutions', () => {
    const typeDict = cicTypeDict();
    const weak: PayloadResolution[] = (['low', 'unresolved'] as const).map((confidence) => ({
      sendSiteFile: 'cic/track_router.c',
      sendSiteLine: 10,
      sendSiteText: 'cic_bus_send(bus, id, p, n)',
      patternName: 'cic_bus_send',
      resolvedStructName: 'TrackKinematics',
      resolvedStruct: typeDict.structs.find((s) => s.name === 'TrackKinematics')!,
      msgIdConstant: 'MSG_TYPE_ENGAGE',
      msgIdValue: '0x33',
      confidence,
      strategy: 'pointer',
      notes: '',
    }));

    const report = analyzeStructRoles({
      typeDict,
      messageInterfaces: cicMessageInterfaces(typeDict),
      payloadResolutions: weak,
      referencedInSource: cicReferencedInSource(),
    });
    expect(report.byName.get('TrackKinematics')?.role).toBe('shared-block');
  });

  it('promotes on a high-confidence payload resolution', () => {
    const typeDict = cicTypeDict();
    const strong: PayloadResolution[] = [{
      sendSiteFile: 'sonar/frame_pub.c',
      sendSiteLine: 42,
      sendSiteText: 'cic_bus_send(bus, MSG_TYPE_SONAR_FRAME, &frame, sizeof(frame))',
      patternName: 'cic_bus_send',
      resolvedStructName: 'SonarFrame',
      resolvedStruct: typeDict.structs.find((s) => s.name === 'SonarFrame')!,
      msgIdConstant: 'MSG_TYPE_SONAR_FRAME',
      msgIdValue: '0x20',
      confidence: 'high',
      strategy: 'address-of',
      notes: '',
    }];

    const report = analyzeStructRoles({
      typeDict,
      messageInterfaces: cicMessageInterfaces(typeDict),
      payloadResolutions: strong,
      referencedInSource: cicReferencedInSource(),
    });
    const sf = report.byName.get('SonarFrame')!;
    expect(sf.role).toBe('wire-root');
    expect(sf.boundConstants).toEqual(['MSG_TYPE_SONAR_FRAME']);
  });
});

// ── Containment graph ─────────────────────────────────────────────────────────

describe('structRoleAnalyzer — containment graph', () => {
  const report = runCic();

  it('records the aggregate parent of a dual-role message', () => {
    const track = report.byName.get('TrackMsg')!;
    expect(track.role).toBe('wire-root-nested');
    expect(track.containedBy.map((e) => e.parent)).toEqual(['PictureTable']);
    expect(track.boundConstants).toEqual(['MSG_TYPE_TRACK']);
  });

  it('resolves typedef aliases when building edges', () => {
    // MotionState embeds DepthFix via the DepthFixAlias typedef.
    expect(report.byName.get('DepthFix')?.containedBy.map((e) => e.parent)).toEqual(
      ['GpsFix', 'MotionState'],
    );
    // NavFixMsg embeds GpsFix via NavFixAlias.
    expect(report.byName.get('GpsFix')?.containedBy.map((e) => e.parent)).toEqual(['NavFixMsg']);
  });

  it('measures depth through the six-level nest', () => {
    // ContactMsg → FusedContact → TrackKinematics → MotionState → DepthFix
    //   → GeoCoord → CicTime → timeval
    expect(report.byName.get('ContactMsg')?.depth).toBe(7);
    expect(report.byName.get('timeval')?.depth).toBe(0);
  });

  it('does not create containment edges through pointers', () => {
    const typeDict = cicTypeDict();
    typeDict.structs.push({
      name: 'TrackRef',
      sourceFile: 'cic/cic_types.h',
      conditional: false,
      fields: [{ type: 'TrackMsg *', name: 'target' }],
    });
    const report2 = analyzeStructRoles({
      typeDict,
      messageInterfaces: cicMessageInterfaces(typeDict),
      payloadResolutions: [],
      referencedInSource: cicReferencedInSource(),
    });
    // A pointer references, it does not compose.
    expect(report2.byName.get('TrackMsg')?.containedBy.map((e) => e.parent)).toEqual(
      ['PictureTable'],
    );
    expect(report2.byName.get('TrackRef')?.pointerFields).toEqual(['target']);
  });

  it('counts a parent once even when it embeds the same block twice', () => {
    const typeDict = cicTypeDict();
    const twice = typeDict.structs.find((s) => s.name === 'AimSolution')!;
    twice.fields.push({ type: 'TrackKinematics', name: 'backup' });
    const report2 = analyzeStructRoles({
      typeDict,
      messageInterfaces: cicMessageInterfaces(typeDict),
      payloadResolutions: [],
      referencedInSource: cicReferencedInSource(),
    });
    expect(report2.byName.get('TrackKinematics')?.inDegree).toBe(4);
  });

  it('survives a self-referential cycle without hanging', () => {
    const typeDict: TypeDict = {
      structs: [
        { name: 'A', sourceFile: 'a.h', conditional: false, fields: [{ type: 'B', name: 'b' }] },
        { name: 'B', sourceFile: 'a.h', conditional: false, fields: [{ type: 'A', name: 'a' }] },
      ],
      enums: [],
      defines: [],
    };
    const report2 = analyzeStructRoles({
      typeDict,
      messageInterfaces: [],
      payloadResolutions: [],
      referencedInSource: new Set(),
    });
    expect(report2.roles).toHaveLength(2);
    expect(report2.byName.get('A')?.depth).toBeGreaterThanOrEqual(1);
  });
});

// ── Wire-format hazards ───────────────────────────────────────────────────────

describe('structRoleAnalyzer — wire hazards', () => {
  const report = runCic();

  it('flags arrays whose length is a macro, since sizeof misreports them', () => {
    expect(report.byName.get('PictureTable')?.variableArrayFields).toEqual([
      'tracks[CIC_MAX_TRACKS]',
    ]);
    expect(report.byName.get('SonarFrame')?.variableArrayFields).toEqual([
      'beams[SONAR_MAX_BEAMS]',
    ]);
  });

  it('does not flag a fixed-length array', () => {
    expect(report.byName.get('LinkReportPkt')?.variableArrayFields).toEqual([]);
    expect(report.byName.get('FusedContact')?.variableArrayFields).toEqual([]);
  });

  it('flags a multi-extent array when any extent is a macro', () => {
    const typeDict = cicTypeDict();
    typeDict.structs.push({
      name: 'Grid',
      sourceFile: 'cic/cic_types.h',
      conditional: false,
      fields: [{ type: 'char', name: 'cells[2][MAX]' }],
    });
    const report2 = analyzeStructRoles({
      typeDict,
      messageInterfaces: cicMessageInterfaces(typeDict),
      payloadResolutions: [],
      referencedInSource: cicReferencedInSource(),
    });
    expect(report2.byName.get('Grid')?.variableArrayFields).toEqual(['cells[2][MAX]']);
  });
});

// ── Determinism ───────────────────────────────────────────────────────────────

describe('structRoleAnalyzer — determinism', () => {
  it('produces byte-identical output across runs', () => {
    // The digest depends on this for prefix caching.
    const a = JSON.stringify(runCic().roles);
    const b = JSON.stringify(runCic().roles);
    expect(a).toBe(b);
  });

  it('is insensitive to input struct ordering', () => {
    const forward = cicTypeDict();
    const reversed = cicTypeDict();
    reversed.structs.reverse();
    const run = (d: TypeDict) =>
      analyzeStructRoles({
        typeDict: d,
        messageInterfaces: cicMessageInterfaces(d),
        payloadResolutions: [],
        referencedInSource: cicReferencedInSource(),
      }).roles.map((r) => `${r.name}:${r.role}:${r.inDegree}`);
    expect(run(reversed)).toEqual(run(forward));
  });
});

// ── Degenerate input ──────────────────────────────────────────────────────────

describe('structRoleAnalyzer — degenerate input', () => {
  it('returns an empty report for an empty type dictionary', () => {
    const report = analyzeStructRoles({
      typeDict: { structs: [], enums: [], defines: [] },
      messageInterfaces: [],
      payloadResolutions: [],
      referencedInSource: new Set(),
    });
    expect(report.roles).toEqual([]);
    expect(report.wireRoots).toEqual([]);
  });

  it('ignores a message interface whose struct never resolved', () => {
    const typeDict = cicTypeDict();
    const unresolved: MessageInterface[] = [{
      msgTypeConstant: 'MSG_TYPE_MYSTERY',
      msgTypeValue: '0x99',
      struct: null,
      structResolved: false,
      direction: 'unknown',
      directionConfident: false,
      transport: null,
      definedIn: 'common/cic_protocol.h',
      usedIn: [],
      fileRoles: [],
    }];
    const report = analyzeStructRoles({
      typeDict,
      messageInterfaces: unresolved,
      payloadResolutions: [],
      referencedInSource: cicReferencedInSource(),
    });
    expect(report.wireRoots).toEqual([]);
  });

  it('classifies an unreferenced, uncontained struct as an orphan', () => {
    const typeDict: TypeDict = {
      structs: [
        { name: 'Lonely', sourceFile: 'x.h', conditional: false,
          fields: [{ type: 'int', name: 'a' }] } as CStruct,
      ],
      enums: [],
      defines: [],
    };
    const report = analyzeStructRoles({
      typeDict, messageInterfaces: [], payloadResolutions: [],
      referencedInSource: new Set(),
    });
    expect(report.byName.get('Lonely')?.role).toBe('orphan');
  });
});
