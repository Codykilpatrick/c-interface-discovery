import { describe, it, expect, beforeEach } from 'vitest';
import { FileRegistry } from '../fileRegistry';
import type { LoadedFile } from '../types';

function makeFile(filename: string, zone: 'string' | 'external', content = ''): LoadedFile {
  return {
    filename,
    content,
    zone,
    encoding: 'utf-8',
    sizeBytes: content.length,
    oversized: false,
    rejected: false,
  };
}

describe('FileRegistry', () => {
  let registry: FileRegistry;

  beforeEach(() => {
    registry = new FileRegistry();
  });

  it('adds files and retrieves them', () => {
    registry.addFiles([makeFile('main.c', 'string')]);
    expect(registry.getAll()).toHaveLength(1);
  });

  it('string zone wins over external zone on filename collision', () => {
    registry.addFiles([makeFile('types.h', 'external', 'extern')]);
    registry.addFiles([makeFile('types.h', 'string', 'string')]);
    const all = registry.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].zone).toBe('string');
  });

  it('emits collision warning when same filename in both zones', () => {
    registry.addFiles([makeFile('types.h', 'external')]);
    registry.addFiles([makeFile('types.h', 'string')]);
    expect(registry.warnings.some((w) => w.kind === 'collision')).toBe(true);
  });

  it('removes a file', () => {
    registry.addFiles([makeFile('main.c', 'string')]);
    registry.removeFile('main.c', 'string');
    expect(registry.getAll()).toHaveLength(0);
  });

  it('getSources returns only .c files from string zone', () => {
    registry.addFiles([
      makeFile('main.c', 'string'),
      makeFile('types.h', 'string'),
      makeFile('extern.h', 'external'),
    ]);
    const sources = registry.getSources();
    expect(sources).toHaveLength(1);
    expect(sources[0].filename).toBe('main.c');
  });

  it('replaces file silently when same filename added twice in same zone', () => {
    registry.addFiles([makeFile('main.c', 'string', 'v1')]);
    registry.addFiles([makeFile('main.c', 'string', 'v2')]);
    const all = registry.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].content).toBe('v2');
    // No collision warning for same-zone replacement
    expect(registry.warnings.filter((w) => w.kind === 'collision')).toHaveLength(0);
  });
});
