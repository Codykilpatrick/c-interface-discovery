import { describe, it, expect } from 'vitest';
import { classifyFile } from '../fileClassifier';
import type { LoadedFile } from '../types';

function makeFile(filename: string, zone: 'string' | 'external'): LoadedFile {
  return {
    filename,
    content: '',
    zone,
    encoding: 'utf-8',
    sizeBytes: 0,
    oversized: false,
    rejected: false,
  };
}

describe('fileClassifier', () => {
  it('classifies .c in string zone as source', () => {
    expect(classifyFile(makeFile('main.c', 'string'))).toBe('source');
  });

  it('classifies .cpp in string zone as source', () => {
    expect(classifyFile(makeFile('main.cpp', 'string'))).toBe('source');
  });

  it('classifies .h in string zone as string-header', () => {
    expect(classifyFile(makeFile('types.h', 'string'))).toBe('string-header');
  });

  it('classifies .h in external zone as external-header', () => {
    expect(classifyFile(makeFile('sys/socket.h', 'external'))).toBe('external-header');
  });

  it('classifies .c in external zone as source (edge case)', () => {
    // .c files dropped in external zone are treated as source
    expect(classifyFile(makeFile('helper.c', 'external'))).toBe('source');
  });
});
