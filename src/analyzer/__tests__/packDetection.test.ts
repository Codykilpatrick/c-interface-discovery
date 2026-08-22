import { describe, it, expect } from 'vitest';
import {
  scanPackPragmas,
  buildPackMap,
  detectPackedAttribute,
  resolvePack,
} from '../packDetection';

describe('packDetection — __attribute__((packed))', () => {
  it.each([
    'struct __attribute__((packed)) S { int a; };',
    'typedef struct { int a; } __attribute__((packed)) S;',
    'typedef struct { int a; } __attribute__((__packed__)) S;',
    'typedef struct { int a; } __attribute__ (( packed )) S;',
    'typedef struct { int a; } __attribute__((packed, aligned(1))) S;',
    'typedef struct { int a; } __attribute__((aligned(1), packed)) S;',
    'typedef struct { int a; } __packed S;',
  ])('detects packing in %s', (decl) => {
    expect(detectPackedAttribute(decl)).toBe(1);
  });

  it.each([
    'typedef struct { int a; } S;',
    'typedef struct { int a; } __attribute__((aligned(8))) S;',
    'typedef struct { int a; } __attribute__((deprecated)) S;',
    // A field named "packed" must not trigger it.
    'typedef struct { int packed; } S;',
  ])('does not detect packing in %s', (decl) => {
    expect(detectPackedAttribute(decl)).toBeUndefined();
  });
});

describe('packDetection — #pragma pack scanning', () => {
  it('parses set, reset, push, and pop', () => {
    const src = [
      '#pragma pack(1)',
      '#pragma pack()',
      '#pragma pack(push, 2)',
      '#pragma pack(push)',
      '#pragma pack(pop)',
    ].join('\n');
    expect(scanPackPragmas(src)).toEqual([
      { line: 0, kind: 'set', value: 1 },
      { line: 1, kind: 'reset' },
      { line: 2, kind: 'push', value: 2 },
      { line: 3, kind: 'push' },
      { line: 4, kind: 'pop' },
    ]);
  });

  it('tolerates whitespace variants', () => {
    const src = '  #  pragma   pack ( 4 )';
    expect(scanPackPragmas(src)).toEqual([{ line: 0, kind: 'set', value: 4 }]);
  });

  it('treats non-power-of-two and zero values as a reset', () => {
    expect(scanPackPragmas('#pragma pack(3)')[0]).toEqual({ line: 0, kind: 'reset' });
    expect(scanPackPragmas('#pragma pack(0)')[0]).toEqual({ line: 0, kind: 'reset' });
    expect(scanPackPragmas('#pragma pack(nonsense)')[0]).toEqual({ line: 0, kind: 'reset' });
  });

  it('ignores unrelated pragmas', () => {
    expect(scanPackPragmas('#pragma once\n#pragma GCC diagnostic push')).toEqual([]);
  });
});

describe('packDetection — pack value in effect per line', () => {
  it('returns undefined when no pragma is present', () => {
    const at = buildPackMap('struct S { int a; };');
    expect(at(0)).toBeUndefined();
  });

  it('applies a set value from its line onward', () => {
    const src = [
      'struct Before { int a; };', // 0
      '#pragma pack(1)',          // 1
      'struct After { int a; };', // 2
    ].join('\n');
    const at = buildPackMap(src);
    expect(at(0)).toBeUndefined();
    expect(at(2)).toBe(1);
  });

  it('restores the outer value on pop', () => {
    const src = [
      '#pragma pack(8)',        // 0
      '#pragma pack(push, 1)',  // 1
      'struct Inner { int a; };', // 2
      '#pragma pack(pop)',      // 3
      'struct Outer { int a; };', // 4
    ].join('\n');
    const at = buildPackMap(src);
    expect(at(2)).toBe(1);
    expect(at(4)).toBe(8);
  });

  it('handles nested push/pop', () => {
    const src = [
      '#pragma pack(push, 8)', // 0
      '#pragma pack(push, 2)', // 1
      '#pragma pack(push, 1)', // 2
      'struct Deep { int a; };', // 3
      '#pragma pack(pop)',     // 4
      'struct Mid { int a; };',  // 5
      '#pragma pack(pop)',     // 6
      'struct Top { int a; };',  // 7
    ].join('\n');
    const at = buildPackMap(src);
    expect(at(3)).toBe(1);
    expect(at(5)).toBe(2);
    expect(at(7)).toBe(8);
  });

  it('resets to natural alignment on an empty pragma', () => {
    const at = buildPackMap('#pragma pack(1)\n#pragma pack()\nstruct S { int a; };');
    expect(at(2)).toBeUndefined();
  });

  it('does not underflow on an unbalanced pop', () => {
    const at = buildPackMap('#pragma pack(pop)\nstruct S { int a; };');
    expect(at(1)).toBeUndefined();
  });
});

describe('packDetection — resolvePack', () => {
  it('prefers the attribute over an in-scope pragma, being more restrictive', () => {
    expect(resolvePack('typedef struct { int a; } __attribute__((packed)) S;', 4)).toEqual({
      packAttribute: 1,
      packSource: 'attribute',
    });
  });

  it('falls back to the pragma when there is no attribute', () => {
    expect(resolvePack('typedef struct { int a; } S;', 2)).toEqual({
      packAttribute: 2,
      packSource: 'pragma',
    });
  });

  it('returns undefined when neither is present, meaning natural alignment', () => {
    expect(resolvePack('typedef struct { int a; } S;', undefined)).toBeUndefined();
  });
});
