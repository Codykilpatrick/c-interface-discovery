import type { CodeLine, FileRef, LoadedFile } from '../analyzer/types';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find every line in each source file that contains `name` as a whole word.
 * Returns one FileRef per file that has at least one match, sorted by filename.
 */
export function findReferences(name: string, sourceFiles: LoadedFile[]): FileRef[] {
  const re = new RegExp(`\\b${escapeRegex(name)}\\b`);
  const result: FileRef[] = [];

  for (const file of sourceFiles) {
    const rawLines = file.content.split('\n');
    const lines: CodeLine[] = [];

    for (let i = 0; i < rawLines.length; i++) {
      const text = rawLines[i].trim();
      if (re.test(text)) {
        lines.push({
          lineNumber: i + 1,
          text: text.length > 120 ? text.slice(0, 117) + '…' : text,
        });
      }
    }

    if (lines.length > 0) {
      result.push({ filename: file.filename, lines });
    }
  }

  return result.sort((a, b) => a.filename.localeCompare(b.filename));
}
