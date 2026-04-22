import { describe, it, expect } from 'vitest';
import { findReferences } from '../findReferences';
import type { LoadedFile } from '../../analyzer/types';

function makeFile(filename: string, content: string): LoadedFile {
  return {
    filename,
    content,
    zone: 'string',
    encoding: 'utf-8',
    sizeBytes: content.length,
    oversized: false,
    rejected: false,
  };
}

describe('findReferences — whole-word matching', () => {
  it('finds a simple reference', () => {
    const files = [makeFile('a.c', 'NavData *data = NULL;')];
    const refs = findReferences('NavData', files);
    expect(refs).toHaveLength(1);
    expect(refs[0].lines).toHaveLength(1);
  });

  it('does not match when name appears only as a substring', () => {
    const files = [makeFile('a.c', '_NavData *data = NULL;')];
    const refs = findReferences('NavData', files);
    expect(refs).toHaveLength(0);
  });

  it('does not match prefix substrings', () => {
    const files = [makeFile('a.c', 'NavDataEx *data = NULL;')];
    const refs = findReferences('NavData', files);
    expect(refs).toHaveLength(0);
  });

  it('does not match suffix substrings', () => {
    const files = [makeFile('a.c', 'MyNavData *data = NULL;')];
    const refs = findReferences('NavData', files);
    expect(refs).toHaveLength(0);
  });

  it('matches when the name is surrounded by punctuation', () => {
    const files = [makeFile('a.c', 'sizeof(NavData)')];
    const refs = findReferences('NavData', files);
    expect(refs).toHaveLength(1);
  });

  it('matches when the name appears after a cast', () => {
    const files = [makeFile('a.c', '(NavData *)buf')];
    const refs = findReferences('NavData', files);
    expect(refs).toHaveLength(1);
  });
});

describe('findReferences — names with leading underscores', () => {
  it('finds references to a name with a leading underscore', () => {
    const files = [makeFile('a.c', '_Hidden *h = get_hidden();')];
    const refs = findReferences('_Hidden', files);
    expect(refs).toHaveLength(1);
  });

  it('does not match a name with fewer underscores', () => {
    const files = [makeFile('a.c', 'Hidden *h = get_hidden();')];
    const refs = findReferences('_Hidden', files);
    expect(refs).toHaveLength(0);
  });
});

describe('findReferences — multiple matches', () => {
  it('reports all matching lines within one file', () => {
    const content = [
      'void send(NavData *d) {',
      '  prepare(d);',
      '  NavData copy = *d;',
      '  transmit(&copy);',
    ].join('\n');
    const files = [makeFile('sender.c', content)];
    const refs = findReferences('NavData', files);
    expect(refs).toHaveLength(1);
    expect(refs[0].lines).toHaveLength(2);
  });

  it('reports matches across multiple files', () => {
    const files = [
      makeFile('a.c', 'NavData *a;'),
      makeFile('b.c', 'void foo() {}'),
      makeFile('c.c', 'NavData b;'),
    ];
    const refs = findReferences('NavData', files);
    expect(refs).toHaveLength(2);
    const filenames = refs.map((r) => r.filename);
    expect(filenames).toContain('a.c');
    expect(filenames).toContain('c.c');
  });

  it('returns an empty array when name is not found in any file', () => {
    const files = [makeFile('a.c', 'int x = 0;'), makeFile('b.c', 'void foo() {}')];
    const refs = findReferences('NavData', files);
    expect(refs).toHaveLength(0);
  });
});

describe('findReferences — line number reporting', () => {
  it('reports the correct 1-based line number', () => {
    const content = ['int x = 0;', 'NavData *d;', 'int y = 1;'].join('\n');
    const files = [makeFile('a.c', content)];
    const refs = findReferences('NavData', files);
    expect(refs[0].lines[0].lineNumber).toBe(2);
  });

  it('reports correct line numbers for multiple matches in one file', () => {
    const content = ['NavData first;', 'int gap;', 'NavData second;'].join('\n');
    const files = [makeFile('a.c', content)];
    const refs = findReferences('NavData', files);
    const lineNums = refs[0].lines.map((l) => l.lineNumber);
    expect(lineNums).toEqual([1, 3]);
  });
});

describe('findReferences — output ordering', () => {
  it('returns files sorted alphabetically by filename', () => {
    const files = [
      makeFile('z.c', 'NavData z;'),
      makeFile('a.c', 'NavData a;'),
      makeFile('m.c', 'NavData m;'),
    ];
    const refs = findReferences('NavData', files);
    const filenames = refs.map((r) => r.filename);
    expect(filenames).toEqual(['a.c', 'm.c', 'z.c']);
  });
});

describe('findReferences — line text trimming', () => {
  it('trims leading/trailing whitespace from matched lines', () => {
    const files = [makeFile('a.c', '    NavData *data;   ')];
    const refs = findReferences('NavData', files);
    expect(refs[0].lines[0].text).toBe('NavData *data;');
  });

  it('truncates very long lines with an ellipsis', () => {
    const longLine = 'NavData ' + 'x'.repeat(200) + ';';
    const files = [makeFile('a.c', longLine)];
    const refs = findReferences('NavData', files);
    const text = refs[0].lines[0].text;
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text.endsWith('…')).toBe(true);
  });
});
