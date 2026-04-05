import Parser from 'web-tree-sitter';
import type { CustomPattern, StringAnalysis } from './types';
import type { FileRegistry } from './fileRegistry';
import { parseHeaders } from './headerParser';
import { analyzeSource } from './sourceAnalyzer';
import { extractMessageInterfaces } from './messagingExtractor';

let _parser: Parser | null = null;

/** Initialize web-tree-sitter. Must be called once before analyzeString(). */
export async function initParser(): Promise<void> {
  await Parser.init({
    locateFile: (_path: string) => '/tree-sitter.wasm',
  });
  _parser = new Parser();
  const C = await Parser.Language.load('/tree-sitter-c.wasm');
  _parser.setLanguage(C);
}

/**
 * Full analysis pipeline. Runs all passes:
 *   1. File classification
 *   2. Header parsing → TypeDict
 *   3. Source analysis → FileAnalysis[]
 *   4. Messaging extraction → MessageInterface[]
 */
export async function analyzeString(
  registry: FileRegistry,
  patterns: CustomPattern[]
): Promise<StringAnalysis> {
  if (!_parser) {
    throw new Error('Parser not initialized. Call initParser() first.');
  }

  const parser = _parser;

  // Pass 1: Collect all warnings from registry (collision warnings)
  const warnings = [...registry.warnings];

  // Pass 2: Parse headers → TypeDict
  const headers = [
    ...registry.getStringHeaders(),
    ...registry.getExternalHeaders(),
  ];
  const headerResult = await parseHeaders(headers, parser);
  const typeDict = headerResult.typeDict;
  warnings.push(...headerResult.warnings);

  // Pass 3: Analyze source files
  const sources = registry.getSources();
  const fileAnalyses = await Promise.all(
    sources.map((f) => analyzeSource(f, parser, typeDict, patterns))
  );

  // Merge structs/enums/defines from source files into typeDict
  for (const fa of fileAnalyses) {
    for (const s of fa.structs) {
      if (!typeDict.structs.some((x) => x.name === s.name)) {
        typeDict.structs.push(s);
      }
    }
    for (const e of fa.enums) {
      if (!typeDict.enums.some((x) => x.name === e.name)) {
        typeDict.enums.push(e);
      }
    }
    for (const d of fa.defines) {
      if (!typeDict.defines.some((x) => x.name === d.name)) {
        typeDict.defines.push(d);
      }
    }
    for (const w of fa.risks.filter(() => false)) {
      // risks don't emit global warnings currently
      void w;
    }
  }

  // Pass 4: Extract messaging interfaces (pass source files for content-based direction inference)
  const messageInterfaces = extractMessageInterfaces(fileAnalyses, typeDict, patterns, sources);

  return {
    files: fileAnalyses,
    typeDict,
    messageInterfaces,
    customPatterns: patterns,
    warnings,
  };
}

export { FileRegistry } from './fileRegistry';
export { PatternRegistry } from './patternRegistry';
export { ingestFiles } from './fileIngestion';
export type * from './types';
