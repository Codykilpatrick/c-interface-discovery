import { describe, it, expect } from 'vitest';
import { buildStructCatalog, computeLayout } from '../structLayoutEngine';
import type { CStructLayout } from '../structLayoutEngine';
import { analyzeStructRoles } from '../structRoleAnalyzer';
import { buildMessageCompositions, summarizeComposition } from '../messageComposition';
import type { MessageComposition } from '../messageComposition';
import type { CStruct, TypeDict } from '../types';
import { cicTypeDict, cicMessageInterfaces, cicReferencedInSource } from './fixtures/cicTypeDict';

function build(target: '32bit' | '64bit' = '64bit') {
  const typeDict = cicTypeDict();
  const messageInterfaces = cicMessageInterfaces(typeDict);
  const catalog = buildStructCatalog(typeDict, { target });
  const structRoles = analyzeStructRoles({
    typeDict, messageInterfaces, payloadResolutions: [],
    structCatalog: catalog, referencedInSource: cicReferencedInSource(),
  });
  const compositions = buildMessageCompositions({
    messageInterfaces, structRoles, typeDict, catalog, target,
  });
  return { typeDict, catalog, structRoles, compositions };
}

function byConstant(comps: MessageComposition[], c: string): MessageComposition {
  const found = comps.find((x) => x.msgConstant === c);
  if (!found) throw new Error(`no composition for ${c}`);
  return found;
}

function layout(name: string, target: '32bit' | '64bit'): CStructLayout {
  const dict = cicTypeDict();
  const found = buildStructCatalog(dict, { target }).layouts.find((l) => l.name === name);
  if (!found) throw new Error(`no layout for ${name}`);
  return found;
}

// ── Padding: the located gap ──────────────────────────────────────────────────

describe('structLayoutEngine — located padding gaps', () => {
  it('reports the composition-boundary gap between hdr and body on 64-bit', () => {
    const gaps = layout('ContactMsg', '64bit').paddingGaps;
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toEqual({
      afterField: 'hdr',
      beforeField: 'body',
      offsetBytes: 12,
      sizeBytes: 4,
      reason: 'align-member',
      causedByAlign: 8,
      causedByType: 'FusedContact',
      atCompositionBoundary: true,
    });
  });

  it('has no such gap on 32-bit, where the same members need only 4-byte alignment', () => {
    expect(layout('ContactMsg', '32bit').paddingGaps).toEqual([]);
  });

  it('reports CicHeader tail padding — 9 bytes of data, 12 on the wire', () => {
    for (const target of ['32bit', '64bit'] as const) {
      const l = layout('CicHeader', target);
      expect(l.totalSizeBytes).toBe(12);
      expect(l.paddingGaps).toEqual([{
        afterField: 'checksum',
        beforeField: null,
        offsetBytes: 9,
        sizeBytes: 3,
        reason: 'align-struct-tail',
        causedByAlign: 4,
        causedByType: null,
        atCompositionBoundary: false,
      }]);
    }
  });

  it('keeps paddingBytes equal to the sum of the gaps', () => {
    for (const l of buildStructCatalog(cicTypeDict(), { target: '64bit' }).layouts) {
      const summed = l.paddingGaps.reduce((n, g) => n + g.sizeBytes, 0);
      expect(summed, `${l.name} padding accounting`).toBe(l.paddingBytes);
    }
  });

  it('does not mark a scalar-adjacent gap as a composition boundary', () => {
    const s: CStruct = {
      name: 'Mixed', sourceFile: 't.h', conditional: false,
      fields: [{ type: 'char', name: 'a' }, { type: 'uint32_t', name: 'b' }],
    };
    const gaps = computeLayout(s, { structs: [], enums: [], defines: [] }, { target: '64bit' })
      .paddingGaps;
    expect(gaps).toHaveLength(1);
    expect(gaps[0].atCompositionBoundary).toBe(false);
    expect(gaps[0].sizeBytes).toBe(3);
  });
});

// ── Typedef chains to primitives ──────────────────────────────────────────────

describe('structLayoutEngine — typedef chains', () => {
  it('resolves __time_t through to long rather than falling back to pointer size', () => {
    // Missing this makes every offset below timeval wrong, and silently.
    expect(layout('timeval', '32bit').totalSizeBytes).toBe(8);
    expect(layout('timeval', '64bit').totalSizeBytes).toBe(16);
    expect(layout('timeval', '64bit').isEstimated).toBe(false);
  });

  it('resolves multi-hop aliases (sa_family_t → __sa_family_t → unsigned short)', () => {
    const l = layout('sockaddr_in', '64bit');
    expect(l.totalSizeBytes).toBe(16);
    expect(l.isEstimated).toBe(false);
    expect(l.fields.find((f) => f.name === 'sin_family')?.sizeBytes).toBe(2);
  });

  it('marks the whole nested chain as resolved, not estimated', () => {
    for (const n of ['CicTime', 'GeoCoord', 'DepthFix', 'MotionState', 'ContactMsg']) {
      expect(layout(n, '64bit').isEstimated, `${n} should resolve`).toBe(false);
    }
  });
});

// ── The 32/64 size table ──────────────────────────────────────────────────────

describe('structLayoutEngine — target portability', () => {
  it.each([
    ['CicHeader',        12,  12],
    ['timeval',           8,  16],
    ['CicTime',          12,  24],
    ['MotionState',      32,  48],
    ['TrackKinematics',  44,  64],
    ['FusedContact',     80, 104],
    ['ContactMsg',      108, 136],
    ['sockaddr_in',      16,  16],
  ])('%s is %i bytes on 32-bit and %i on 64-bit', (name, s32, s64) => {
    expect(layout(name as string, '32bit').totalSizeBytes).toBe(s32);
    expect(layout(name as string, '64bit').totalSizeBytes).toBe(s64);
  });
});

// ── Composition summary ───────────────────────────────────────────────────────

describe('messageComposition — summary render', () => {
  const { compositions } = build('64bit');

  it('produces one composition per resolved message interface', () => {
    expect(compositions.map((c) => c.msgConstant)).toEqual([
      'MSG_ID_NAV_FIX', 'MSG_TYPE_CONTACT', 'MSG_TYPE_ENGAGE', 'MSG_TYPE_HEARTBEAT',
      'MSG_TYPE_OWN_SHIP', 'MSG_TYPE_TRACK', 'MSG_TYPE_WEAPON_ORD', 'PKT_TYPE_LINK_REPORT',
    ]);
  });

  it.each([
    ['MSG_TYPE_CONTACT',     'CicHeader + pad(4) + FusedContact + sockaddr_in'],
    ['MSG_TYPE_OWN_SHIP',    'CicHeader + pad(4) + MotionState + fix_quality + pad(4)'],
    ['MSG_TYPE_TRACK',       'CicHeader + track_id + TrackKinematics + source + pad(4)'],
    ['MSG_TYPE_ENGAGE',      'CicHeader + track_id + weapon_id + auth_flags + TrackKinematics'],
    ['MSG_TYPE_WEAPON_ORD',  'CicHeader + tube_id + track_id + weapon_type'],
    ['PKT_TYPE_LINK_REPORT', 'CicHeader + n_tracks + own_ship_seq + note[64]'],
    ['MSG_TYPE_HEARTBEAT',   'CicHeader + origin'],
    ['MSG_ID_NAV_FIX',       'CicHeader + pad(4) + GpsFix + source + pad(4)'],
  ])('renders %s as %s', (constant, expected) => {
    expect(summarizeComposition(byConstant(compositions, constant))).toBe(expected);
  });

  it('flags exactly 5 of 8 messages as differing across targets', () => {
    const differing = compositions.filter((c) => c.differsAcrossTargets).map((c) => c.msgConstant);
    expect(differing.sort()).toEqual([
      'MSG_ID_NAV_FIX', 'MSG_TYPE_CONTACT', 'MSG_TYPE_ENGAGE',
      'MSG_TYPE_OWN_SHIP', 'MSG_TYPE_TRACK',
    ]);
  });

  it('leaves messages with no long anywhere in their tree target-stable', () => {
    for (const c of ['MSG_TYPE_WEAPON_ORD', 'PKT_TYPE_LINK_REPORT', 'MSG_TYPE_HEARTBEAT']) {
      expect(byConstant(compositions, c).differsAcrossTargets).toBe(false);
    }
  });

  it('records both target sizes regardless of which one is rendered', () => {
    const c = byConstant(compositions, 'MSG_TYPE_CONTACT');
    expect(c.sizeByTarget).toEqual({ '32bit': 108, '64bit': 136 });
  });

  it('reports the same sizes when built for the 32-bit target', () => {
    const c = byConstant(build('32bit').compositions, 'MSG_TYPE_CONTACT');
    expect(c.sizeByTarget).toEqual({ '32bit': 108, '64bit': 136 });
    // ...but renders the 32-bit part list, which has no gap.
    expect(summarizeComposition(c)).toBe('CicHeader + FusedContact + sockaddr_in');
  });
});

// ── Composition parts ─────────────────────────────────────────────────────────

describe('messageComposition — part list', () => {
  const { compositions } = build('64bit');
  const contact = byConstant(compositions, 'MSG_TYPE_CONTACT');

  it('orders parts by wire offset with padding as its own row', () => {
    expect(contact.parts.map((p) => [p.kind, p.name ?? p.typeName, p.offsetBytes])).toEqual([
      ['block',   'hdr',    0],
      ['padding', null,     12],
      ['block',   'body',   16],
      ['block',   'origin', 120],
    ]);
  });

  it('carries the struct role onto each block part', () => {
    expect(contact.parts.find((p) => p.name === 'hdr')?.role).toBe('envelope');
    expect(contact.parts.find((p) => p.name === 'body')?.role).toBe('shared-block');
  });

  it('attributes the padding row to the type that forced it', () => {
    const pad = contact.parts.find((p) => p.kind === 'padding')!;
    expect(pad.causedByType).toBe('FusedContact');
    expect(pad.causedByAlign).toBe(8);
    expect(pad.atCompositionBoundary).toBe(true);
  });

  it('recurses into nested blocks down the six-level chain', () => {
    const body = contact.parts.find((p) => p.name === 'body')!;
    const kin = body.children?.find((p) => p.name === 'kin');
    const motion = kin?.children?.find((p) => p.name === 'motion');
    const pos = motion?.children?.find((p) => p.name === 'pos');
    expect(kin?.typeName).toBe('TrackKinematics');
    expect(motion?.typeName).toBe('MotionState');
    expect(pos?.typeName).toBe('DepthFix'); // resolved through DepthFixAlias
  });

  it('uses absolute offsets in nested parts', () => {
    const body = contact.parts.find((p) => p.name === 'body')!;
    expect(body.offsetBytes).toBe(16);
    expect(body.children?.find((p) => p.name === 'kin')?.offsetBytes).toBe(16);
  });
});

// ── Hazards ───────────────────────────────────────────────────────────────────

describe('messageComposition — wire hazards', () => {
  it('surfaces variable-length arrays from anywhere in the tree', () => {
    // A message embedding PictureTable inherits its macro-length array warning.
    const typeDict = cicTypeDict();
    const messageInterfaces = cicMessageInterfaces(typeDict);
    typeDict.structs.push({
      name: 'PictureMsg', sourceFile: 'cic/cic_types.h', conditional: false,
      fields: [{ type: 'CicHeader', name: 'hdr' }, { type: 'PictureTable', name: 'pic' }],
    });
    messageInterfaces.push({
      msgTypeConstant: 'MSG_TYPE_PICTURE', msgTypeValue: '0x36',
      struct: typeDict.structs.find((s) => s.name === 'PictureMsg')!,
      structResolved: true, direction: 'producer', directionConfident: true,
      transport: 'custom', definedIn: 'cic/cic_types.h', usedIn: [], fileRoles: [],
    });
    const catalog = buildStructCatalog(typeDict, { target: '64bit' });
    const structRoles = analyzeStructRoles({
      typeDict, messageInterfaces, payloadResolutions: [],
      structCatalog: catalog, referencedInSource: cicReferencedInSource(),
    });
    const comps = buildMessageCompositions({
      messageInterfaces, structRoles, typeDict, catalog, target: '64bit',
    });
    expect(byConstant(comps, 'MSG_TYPE_PICTURE').variableArrayWarnings).toContain(
      'PictureTable.tracks[CIC_MAX_TRACKS]',
    );
  });

  it('reports no hazards for a flat, fixed-size message', () => {
    const c = byConstant(build('64bit').compositions, 'MSG_TYPE_WEAPON_ORD');
    expect(c.pointerWarnings).toEqual([]);
    expect(c.variableArrayWarnings).toEqual([]);
  });
});

// ── Packing ───────────────────────────────────────────────────────────────────

describe('messageComposition — packing', () => {
  it('removes the boundary gap when the root struct is packed', () => {
    const typeDict = cicTypeDict();
    const contact = typeDict.structs.find((s) => s.name === 'ContactMsg')!;
    contact.packAttribute = 1;
    contact.packSource = 'attribute';

    const l = buildStructCatalog(typeDict, { target: '64bit' })
      .layouts.find((x) => x.name === 'ContactMsg')!;
    expect(l.packAttribute).toBe(1);
    expect(l.packSource).toBe('attribute');
    expect(l.paddingGaps).toEqual([]);
    // Packed is strictly smaller than the natural 136.
    expect(l.totalSizeBytes).toBeLessThan(136);
  });

  it('surfaces packAttribute on the composition so the UI can badge it', () => {
    const typeDict = cicTypeDict();
    typeDict.structs.find((s) => s.name === 'HeartbeatMsg')!.packAttribute = 1;
    const messageInterfaces = cicMessageInterfaces(typeDict);
    const catalog = buildStructCatalog(typeDict, { target: '64bit' });
    const structRoles = analyzeStructRoles({
      typeDict, messageInterfaces, payloadResolutions: [],
      structCatalog: catalog, referencedInSource: cicReferencedInSource(),
    });
    const comps = buildMessageCompositions({
      messageInterfaces, structRoles, typeDict, catalog, target: '64bit',
    });
    expect(byConstant(comps, 'MSG_TYPE_HEARTBEAT').packAttribute).toBe(1);
  });
});

// ── Determinism and degenerate input ──────────────────────────────────────────

describe('messageComposition — determinism', () => {
  it('produces byte-identical output across runs', () => {
    expect(JSON.stringify(build('64bit').compositions))
      .toBe(JSON.stringify(build('64bit').compositions));
  });

  it('skips message interfaces whose struct never resolved', () => {
    const typeDict = cicTypeDict();
    const messageInterfaces = cicMessageInterfaces(typeDict);
    messageInterfaces.push({
      msgTypeConstant: 'MSG_TYPE_MYSTERY', msgTypeValue: '0x99', struct: null,
      structResolved: false, direction: 'unknown', directionConfident: false,
      transport: null, definedIn: 'x.h', usedIn: [], fileRoles: [],
    });
    const catalog = buildStructCatalog(typeDict, { target: '64bit' });
    const structRoles = analyzeStructRoles({
      typeDict, messageInterfaces, payloadResolutions: [],
      structCatalog: catalog, referencedInSource: cicReferencedInSource(),
    });
    const comps = buildMessageCompositions({
      messageInterfaces, structRoles, typeDict, catalog, target: '64bit',
    });
    expect(comps.map((c) => c.msgConstant)).not.toContain('MSG_TYPE_MYSTERY');
  });

  it('returns an empty list when there are no messages', () => {
    const typeDict: TypeDict = { structs: [], enums: [], defines: [] };
    const catalog = buildStructCatalog(typeDict, { target: '64bit' });
    expect(buildMessageCompositions({
      messageInterfaces: [],
      structRoles: analyzeStructRoles({
        typeDict, messageInterfaces: [], payloadResolutions: [],
        referencedInSource: new Set(),
      }),
      typeDict, catalog, target: '64bit',
    })).toEqual([]);
  });
});
