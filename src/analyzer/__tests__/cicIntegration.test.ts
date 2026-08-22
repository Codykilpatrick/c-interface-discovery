/**
 * End-to-end over the real `test-fixtures/synthetic-cic/` headers, parsed with
 * the actual tree-sitter grammar rather than a hand-built TypeDict.
 *
 * The unit tests use a transcribed dictionary, which cannot catch parser-side
 * regressions — a dropped array member or an unresolved typedef looks identical
 * to a correct layout until you compare against the source. This closes that gap.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import Parser from 'web-tree-sitter';
import fs from 'node:fs';
import path from 'node:path';
import { parseHeaders } from '../headerParser';
import { buildStructCatalog } from '../structLayoutEngine';
import type { CStructLayout } from '../structLayoutEngine';
import type { LoadedFile, TypeDict } from '../types';

const FIXTURE = path.resolve('test-fixtures/synthetic-cic');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.h$/.test(e.name) ? [p] : [];
  });
}

/** Filenames keep their path relative to the fixture root, as a directory drop would. */
function load(dir: string): LoadedFile[] {
  return walk(dir).map((abs) => ({
    filename: path.relative(FIXTURE, abs).replace(/\\/g, '/'),
    content: fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n'),
    zone: 'external' as const,
    encoding: 'utf-8' as const,
    sizeBytes: fs.statSync(abs).size,
    oversized: false,
    rejected: false,
  }));
}

let typeDict: TypeDict;
const at = (name: string, target: '32bit' | '64bit'): CStructLayout => {
  const l = buildStructCatalog(typeDict, { target }).layouts.find((x) => x.name === name);
  if (!l) throw new Error(`no layout for ${name}`);
  return l;
};

beforeAll(async () => {
  await Parser.init({ locateFile: () => path.resolve('public/tree-sitter.wasm') });
  const parser = new Parser();
  parser.setLanguage(await Parser.Language.load(path.resolve('public/tree-sitter-c.wasm')));
  // `common/` and `usr/include/` only — the per-app dirs redefine TrackMsg and
  // PlatformStamp on purpose, and conflict resolution is not what this tests.
  const files = [...load(path.join(FIXTURE, 'common')), ...load(path.join(FIXTURE, 'usr/include'))];
  typeDict = (await parseHeaders(files, parser)).typeDict;
});

describe('cic integration — field extraction', () => {
  it('keeps array members, which a declarator-type filter silently drops', () => {
    const fields = (n: string) => typeDict.structs.find((s) => s.name === n)!.fields.map((f) => f.name);
    expect(fields('sockaddr_in')).toEqual(['sin_family', 'sin_port', 'sin_addr', 'sin_zero[8]']);
    expect(fields('FusedContact')).toEqual(['kin', 'sensor_id', 'label[32]']);
    expect(fields('LinkReportPkt')).toEqual(['hdr', 'n_tracks', 'own_ship_seq', 'note[64]']);
  });

  it('records multi-word typedef aliases, not just single-word ones', () => {
    // `typedef unsigned short __sa_family_t;` — a \w+ base-type pattern misses these,
    // and the layout engine then substitutes pointer size.
    expect(typeDict.typedefAliases?.['__sa_family_t']).toBe('unsigned short');
    expect(typeDict.typedefAliases?.['__be32']).toBe('unsigned int');
    expect(typeDict.typedefAliases?.['__time_t']).toBe('long');
    expect(typeDict.typedefAliases?.['sa_family_t']).toBe('__sa_family_t');
  });
});

describe('cic integration — layout against real headers', () => {
  it('resolves every message struct without estimation', () => {
    for (const n of ['CicHeader', 'ContactMsg', 'OwnShipMsg', 'EngageMsg',
                     'WeaponOrdMsg', 'LinkReportPkt', 'HeartbeatMsg']) {
      expect(at(n, '64bit').isEstimated, `${n} should fully resolve`).toBe(false);
    }
  });

  it.each([
    ['CicHeader',        12,  12],
    ['timeval',           8,  16],
    ['CicTime',          12,  24],
    ['MotionState',      32,  48],
    ['TrackKinematics',  44,  64],
    ['FusedContact',     80, 104],
    ['sockaddr_in',      16,  16],
    ['ContactMsg',      108, 136],
  ])('%s is %i bytes on 32-bit and %i on 64-bit', (name, s32, s64) => {
    expect(at(name as string, '32bit').totalSizeBytes).toBe(s32);
    expect(at(name as string, '64bit').totalSizeBytes).toBe(s64);
  });

  it('reports the composition-boundary gap between hdr and body on 64-bit only', () => {
    expect(at('ContactMsg', '64bit').paddingGaps).toEqual([{
      afterField: 'hdr', beforeField: 'body', offsetBytes: 12, sizeBytes: 4,
      reason: 'align-member', causedByAlign: 8, causedByType: 'FusedContact',
      atCompositionBoundary: true,
    }]);
    expect(at('ContactMsg', '32bit').paddingGaps).toEqual([]);
  });

  it('detects no packing in these headers, so offsets assume natural alignment', () => {
    expect(at('ContactMsg', '64bit').packAttribute).toBeUndefined();
  });
});

describe('cic integration — packing on real source', () => {
  let packed: TypeDict;

  beforeAll(async () => {
    await Parser.init({ locateFile: () => path.resolve('public/tree-sitter.wasm') });
    const parser = new Parser();
    parser.setLanguage(await Parser.Language.load(path.resolve('public/tree-sitter-c.wasm')));
    const src = [
      '#include <stdint.h>',
      'typedef struct { uint8_t a; uint32_t b; } __attribute__((packed)) PackedAttr;',
      '#pragma pack(push, 1)',
      'typedef struct { uint8_t a; uint32_t b; } PackedPragma;',
      '#pragma pack(pop)',
      'typedef struct { uint8_t a; uint32_t b; } Natural;',
    ].join('\n');
    packed = (await parseHeaders([{
      filename: 'packed.h', content: src, zone: 'external',
      encoding: 'utf-8', sizeBytes: src.length, oversized: false, rejected: false,
    }], parser)).typeDict;
  });

  it('picks up __attribute__((packed)) from the declaration', () => {
    const s = packed.structs.find((x) => x.name === 'PackedAttr')!;
    expect(s.packAttribute).toBe(1);
    expect(s.packSource).toBe('attribute');
    expect(buildStructCatalog(packed, { target: '64bit' })
      .layouts.find((l) => l.name === 'PackedAttr')!.totalSizeBytes).toBe(5);
  });

  it('picks up an enclosing #pragma pack and does not leak it past the pop', () => {
    const pragma = packed.structs.find((x) => x.name === 'PackedPragma')!;
    expect(pragma.packAttribute).toBe(1);
    expect(pragma.packSource).toBe('pragma');

    const natural = packed.structs.find((x) => x.name === 'Natural')!;
    expect(natural.packAttribute).toBeUndefined();

    const cat = buildStructCatalog(packed, { target: '64bit' });
    expect(cat.layouts.find((l) => l.name === 'PackedPragma')!.totalSizeBytes).toBe(5);
    expect(cat.layouts.find((l) => l.name === 'Natural')!.totalSizeBytes).toBe(8);
  });
});
