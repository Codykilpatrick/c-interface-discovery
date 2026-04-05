import { describe, it, expect } from 'vitest';
import { extractConditionalBlocks } from '../preprocessor';

describe('preprocessor', () => {
  it('returns hasConditionals false for plain source', () => {
    const result = extractConditionalBlocks('int x = 1;\n');
    expect(result.hasConditionals).toBe(false);
    expect(result.blocks).toHaveLength(0);
  });

  it('detects a simple #ifdef block', () => {
    const src = `
#ifdef DEBUG
int debug_level = 1;
#endif
`;
    const result = extractConditionalBlocks(src);
    expect(result.hasConditionals).toBe(true);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].condition).toBe('DEBUG');
  });

  it('collects both branches of #ifdef/#else', () => {
    const src = `
#ifdef FEATURE_A
  #define MAX_BUF 1024
#else
  #define MAX_BUF 512
#endif
`;
    const result = extractConditionalBlocks(src);
    expect(result.blocks[0].branchTexts).toHaveLength(2);
  });

  it('handles #ifndef', () => {
    const src = `
#ifndef TYPES_H
#define TYPES_H
typedef int myint;
#endif
`;
    const result = extractConditionalBlocks(src);
    expect(result.hasConditionals).toBe(true);
  });
});
