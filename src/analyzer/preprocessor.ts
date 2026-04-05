export interface ConditionalBlock {
  startLine: number;
  endLine: number;
  condition: string;
  branchTexts: string[];  // one entry per branch (if / else if / else)
}

export interface PreprocessorResult {
  /** Lines with #ifdef/#else/#endif stripped, all branches inlined */
  strippedContent: string;
  /** All conditional blocks found */
  blocks: ConditionalBlock[];
  /** Whether any conditional blocks were detected */
  hasConditionals: boolean;
}

const IFDEF_RE = /^[ \t]*#\s*ifdef\s+(\w+)/;
const IFNDEF_RE = /^[ \t]*#\s*ifndef\s+(\w+)/;
const ELIF_RE = /^[ \t]*#\s*elif\b/;
const ELSE_RE = /^[ \t]*#\s*else\b/;
const ENDIF_RE = /^[ \t]*#\s*endif\b/;

export function extractConditionalBlocks(content: string): PreprocessorResult {
  const lines = content.split('\n');
  const blocks: ConditionalBlock[] = [];

  // Stack entry: { startLine, condition, branches: string[][], currentBranch: string[] }
  type StackEntry = {
    startLine: number;
    condition: string;
    branches: string[][];
    currentBranch: string[];
  };
  const stack: StackEntry[] = [];
  const strippedLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const ifdefMatch = IFDEF_RE.exec(line) ?? IFNDEF_RE.exec(line);
    if (ifdefMatch) {
      const entry: StackEntry = {
        startLine: i,
        condition: ifdefMatch[1],
        branches: [],
        currentBranch: [],
      };
      stack.push(entry);
      // Strip directive from stripped content (replace with blank)
      strippedLines.push('');
      continue;
    }

    if (stack.length > 0) {
      const top = stack[stack.length - 1];

      if (ELIF_RE.test(line) || ELSE_RE.test(line)) {
        top.branches.push(top.currentBranch);
        top.currentBranch = [];
        strippedLines.push('');
        continue;
      }

      if (ENDIF_RE.test(line)) {
        top.branches.push(top.currentBranch);
        blocks.push({
          startLine: top.startLine,
          endLine: i,
          condition: top.condition,
          branchTexts: top.branches.map((b) => b.join('\n')),
        });
        stack.pop();
        strippedLines.push('');
        continue;
      }

      // Line belongs to current branch — add to both branch text and stripped output
      top.currentBranch.push(line);
      strippedLines.push(line);
      continue;
    }

    strippedLines.push(line);
  }

  // Handle unclosed blocks (malformed source)
  while (stack.length > 0) {
    const top = stack.pop()!;
    top.branches.push(top.currentBranch);
    blocks.push({
      startLine: top.startLine,
      endLine: lines.length - 1,
      condition: top.condition,
      branchTexts: top.branches.map((b) => b.join('\n')),
    });
  }

  return {
    strippedContent: strippedLines.join('\n'),
    blocks,
    hasConditionals: blocks.length > 0,
  };
}
