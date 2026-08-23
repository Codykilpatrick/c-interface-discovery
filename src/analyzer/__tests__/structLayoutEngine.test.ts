import { describe, it, expect } from 'vitest';
import { computeLayout, buildStructCatalog } from '../structLayoutEngine';
import type { LayoutOptions } from '../structLayoutEngine';
import type { CStruct, TypeDict } from '../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStruct(name: string, fields: { type: string; name: string }[], sourceFile = 'test.h'): CStruct {
  return { name, fields, sourceFile, conditional: false };
}

function emptyTypeDict(): TypeDict {
  return { structs: [], enums: [], defines: [] };
}

const opts32: LayoutOptions = { target: '32bit' };
const opts64: LayoutOptions = { target: '64bit' };

// ── Primitive fields ──────────────────────────────────────────────────────────

describe('structLayoutEngine — primitive fields (32-bit)', () => {
  it('lays out a simple struct with no padding', () => {
    const s = makeStruct('Simple', [
      { type: 'uint8_t',  name: 'a' },
      { type: 'uint8_t',  name: 'b' },
      { type: 'uint16_t', name: 'c' },
      { type: 'uint32_t', name: 'd' },
    ]);
    const layout = computeLayout(s, emptyTypeDict(), opts32);
    expect(layout.totalSizeBytes).toBe(8);
    expect(layout.paddingBytes).toBe(0);
    expect(layout.fields[0].offsetBytes).toBe(0);
    expect(layout.fields[1].offsetBytes).toBe(1);
    expect(layout.fields[2].offsetBytes).toBe(2);
    expect(layout.fields[3].offsetBytes).toBe(4);
  });

  it('inserts padding between uint8_t and uint32_t', () => {
    const s = makeStruct('Padded', [
      { type: 'uint8_t',  name: 'a' },
      { type: 'uint32_t', name: 'b' },
    ]);
    const layout = computeLayout(s, emptyTypeDict(), opts32);
    expect(layout.fields[0].offsetBytes).toBe(0);
    expect(layout.fields[1].offsetBytes).toBe(4); // 3 bytes padding
    expect(layout.totalSizeBytes).toBe(8);
    expect(layout.paddingBytes).toBe(3);
  });

  it('inserts tail padding to align struct size to largest member', () => {
    const s = makeStruct('TailPad', [
      { type: 'uint32_t', name: 'a' },
      { type: 'uint8_t',  name: 'b' },
    ]);
    const layout = computeLayout(s, emptyTypeDict(), opts32);
    expect(layout.totalSizeBytes).toBe(8);
    expect(layout.fields[1].offsetBytes).toBe(4);
  });

  it('handles double on 32-bit with 4-byte alignment', () => {
    const s = makeStruct('WithDouble', [
      { type: 'uint8_t', name: 'a' },
      { type: 'double',  name: 'x' },
    ]);
    const layout = computeLayout(s, emptyTypeDict(), opts32);
    expect(layout.fields[1].offsetBytes).toBe(4); // aligned to 4
    expect(layout.fields[1].sizeBytes).toBe(8);
    expect(layout.totalSizeBytes).toBe(12);
  });
});

describe('structLayoutEngine — primitive fields (64-bit)', () => {
  it('long is 8 bytes on 64-bit', () => {
    const s = makeStruct('LongTest', [
      { type: 'uint8_t', name: 'a' },
      { type: 'long',    name: 'x' },
    ]);
    const layout = computeLayout(s, emptyTypeDict(), opts64);
    expect(layout.fields[1].sizeBytes).toBe(8);
    expect(layout.fields[1].offsetBytes).toBe(8);
    expect(layout.totalSizeBytes).toBe(16);
  });

  it('pointer is 8 bytes on 64-bit', () => {
    const s = makeStruct('PtrTest', [
      { type: 'uint32_t', name: 'a' },
      { type: 'char *',   name: 'p' },
    ]);
    const layout = computeLayout(s, emptyTypeDict(), opts64);
    expect(layout.fields[1].isPointer).toBe(true);
    expect(layout.fields[1].sizeBytes).toBe(8);
    expect(layout.fields[1].offsetBytes).toBe(8);
  });

  it('pointer is 4 bytes on 32-bit', () => {
    const s = makeStruct('PtrTest32', [
      { type: 'char *', name: 'p' },
    ]);
    const layout = computeLayout(s, emptyTypeDict(), opts32);
    expect(layout.fields[0].sizeBytes).toBe(4);
  });

  it('aligns double to 8 bytes on 64-bit', () => {
    const s = makeStruct('WithDouble', [
      { type: 'char', name: 'a' },
      { type: 'double', name: 'x' },
    ]);
    const layout = computeLayout(s, emptyTypeDict(), opts64);
    expect(layout.fields[1].offsetBytes).toBe(8);
    expect(layout.totalSizeBytes).toBe(16);
  });

  it('lays out an array of pointers as N machine words', () => {
    const s = makeStruct('Names', [
      { type: 'char *', name: 'name[32]' },
    ]);
    const layout = computeLayout(s, emptyTypeDict(), opts64);
    expect(layout.fields[0].isPointer).toBe(true);
    expect(layout.fields[0].isArray).toBe(true);
    expect(layout.fields[0].sizeBytes).toBe(256);
  });
});

// ── Nested structs ────────────────────────────────────────────────────────────

describe('structLayoutEngine — nested structs', () => {
  it('correctly computes offsets for nested struct', () => {
    const inner = makeStruct('Inner', [
      { type: 'uint16_t', name: 'x' },
      { type: 'uint16_t', name: 'y' },
    ]);
    const outer = makeStruct('Outer', [
      { type: 'uint8_t', name: 'flag' },
      { type: 'Inner',   name: 'pos' },
      { type: 'uint32_t', name: 'id' },
    ]);
    const td: TypeDict = { structs: [inner, outer], enums: [], defines: [] };
    const layout = computeLayout(outer, td, opts32);

    // Inner is 4 bytes, align 2. flag at 0, 1 byte, then 1 pad to align Inner.
    expect(layout.fields[0].offsetBytes).toBe(0); // flag
    expect(layout.fields[1].offsetBytes).toBe(2); // Inner (aligned to 2)
    expect(layout.fields[1].sizeBytes).toBe(4);
    expect(layout.fields[2].offsetBytes).toBe(8); // uint32_t (aligned to 4 after Inner ends at 6, +2 pad)
    expect(layout.totalSizeBytes).toBe(12);
  });

  it('handles unknown nested type by using pointer size', () => {
    const s = makeStruct('WithUnknown', [
      { type: 'SomeUnknownType', name: 'x' },
    ]);
    const layout = computeLayout(s, emptyTypeDict(), opts64);
    expect(layout.isEstimated).toBe(true);
    expect(layout.fields[0].sizeBytes).toBe(8); // pointer size fallback
  });
});

// ── Packed structs ────────────────────────────────────────────────────────────

describe('structLayoutEngine — packed (packOverride=1)', () => {
  it('no padding when pack=1', () => {
    const s = makeStruct('Packed', [
      { type: 'uint8_t',  name: 'a' },
      { type: 'uint32_t', name: 'b' },
      { type: 'uint16_t', name: 'c' },
    ]);
    const layout = computeLayout(s, emptyTypeDict(), { target: '32bit', packOverride: 1 });
    expect(layout.fields[0].offsetBytes).toBe(0);
    expect(layout.fields[1].offsetBytes).toBe(1);
    expect(layout.fields[2].offsetBytes).toBe(5);
    expect(layout.totalSizeBytes).toBe(7);
    expect(layout.paddingBytes).toBe(0);
  });

  it('does not re-lay out an unpacked child inside a packed parent', () => {
    const inner = makeStruct('Inner', [
      { type: 'char', name: 'a' },
      { type: 'int', name: 'b' },
    ]);
    const outer = makeStruct('Outer', [
      { type: 'char', name: 'x' },
      { type: 'Inner', name: 'i' },
    ]);
    outer.packAttribute = 1;
    const td: TypeDict = { structs: [inner, outer], enums: [], defines: [] };
    const layout = computeLayout(outer, td, opts64);
    // Inner stays 8 bytes; packed placement puts it at offset 1. Total 9.
    expect(layout.fields[1].offsetBytes).toBe(1);
    expect(layout.fields[1].sizeBytes).toBe(8);
    expect(layout.totalSizeBytes).toBe(9);
  });

  it('pack=2 limits alignment to 2', () => {
    const s = makeStruct('Pack2', [
      { type: 'uint8_t',  name: 'a' },
      { type: 'uint32_t', name: 'b' },
    ]);
    const layout = computeLayout(s, emptyTypeDict(), { target: '32bit', packOverride: 2 });
    expect(layout.fields[1].offsetBytes).toBe(2); // aligned to min(4,2)=2
    expect(layout.totalSizeBytes).toBe(6);
  });
});

// ── Arrays ────────────────────────────────────────────────────────────────────

describe('structLayoutEngine — arrays', () => {
  it('computes total size for char array', () => {
    const s = makeStruct('WithArray', [
      { type: 'char', name: 'name[32]' },
      { type: 'uint32_t', name: 'id' },
    ]);
    const layout = computeLayout(s, emptyTypeDict(), opts32);
    expect(layout.fields[0].isArray).toBe(true);
    expect(layout.fields[0].arrayLength).toBe(32);
    expect(layout.fields[0].sizeBytes).toBe(32);
    expect(layout.fields[1].offsetBytes).toBe(32);
    expect(layout.totalSizeBytes).toBe(36);
  });

  it('marks a macro-length array as estimated rather than one element', () => {
    const s = makeStruct('Batch', [
      { type: 'int', name: 'tracks[CIC_MAX_TRACKS]' },
    ]);
    const layout = computeLayout(s, emptyTypeDict(), opts64);
    expect(layout.fields[0].isArray).toBe(true);
    expect(layout.fields[0].arrayLength).toBeUndefined();
    expect(layout.isEstimated).toBe(true);
  });

  it('computes total size for uint32_t array', () => {
    const s = makeStruct('IntArray', [
      { type: 'uint32_t', name: 'data[4]' },
    ]);
    const layout = computeLayout(s, emptyTypeDict(), opts32);
    expect(layout.fields[0].sizeBytes).toBe(16);
    expect(layout.totalSizeBytes).toBe(16);
  });
});

// ── Typedef resolution ────────────────────────────────────────────────────────

describe('structLayoutEngine — typedef resolution', () => {
  it('resolves a field type that matches a struct name', () => {
    const inner = makeStruct('Header', [
      { type: 'uint16_t', name: 'msg_type' },
      { type: 'uint16_t', name: 'length' },
    ]);
    const outer = makeStruct('Packet', [
      { type: 'Header',   name: 'hdr' },
      { type: 'uint8_t',  name: 'payload' },
    ]);
    const td: TypeDict = { structs: [inner, outer], enums: [], defines: [] };
    const layout = computeLayout(outer, td, opts32);
    expect(layout.fields[0].sizeBytes).toBe(4); // Header = 4 bytes
    expect(layout.fields[1].offsetBytes).toBe(4);
  });
});

// ── buildStructCatalog ────────────────────────────────────────────────────────

describe('buildStructCatalog', () => {
  it('includes all structs with fields', () => {
    const td: TypeDict = {
      structs: [
        makeStruct('Foo', [{ type: 'uint32_t', name: 'x' }]),
        makeStruct('Bar', [{ type: 'uint8_t', name: 'a' }, { type: 'uint8_t', name: 'b' }]),
        makeStruct('Empty', []), // should be skipped
      ],
      enums: [], defines: [],
    };
    const catalog = buildStructCatalog(td, opts32);
    expect(catalog.layouts.map((l) => l.name)).toContain('Foo');
    expect(catalog.layouts.map((l) => l.name)).toContain('Bar');
    expect(catalog.layouts.map((l) => l.name)).not.toContain('Empty');
  });

  it('computes correct layout for each struct', () => {
    const td: TypeDict = {
      structs: [
        makeStruct('Simple', [
          { type: 'uint8_t',  name: 'a' },
          { type: 'uint32_t', name: 'b' },
        ]),
      ],
      enums: [], defines: [],
    };
    const catalog = buildStructCatalog(td, opts32);
    const layout = catalog.layouts.find((l) => l.name === 'Simple')!;
    expect(layout).toBeDefined();
    expect(layout.fields[1].offsetBytes).toBe(4);
    expect(layout.totalSizeBytes).toBe(8);
  });

  it('typedefMap contains all struct names', () => {
    const td: TypeDict = {
      structs: [
        makeStruct('Alpha', [{ type: 'uint32_t', name: 'x' }]),
        makeStruct('Beta',  [{ type: 'uint16_t', name: 'y' }]),
      ],
      enums: [], defines: [],
    };
    const catalog = buildStructCatalog(td, opts64);
    expect(catalog.typedefMap.has('Alpha')).toBe(true);
    expect(catalog.typedefMap.has('Beta')).toBe(true);
  });
});
