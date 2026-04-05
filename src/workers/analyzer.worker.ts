// Web Worker for analyzing oversized files (500KB–2MB) off the main thread.
// Receives a single file to analyze and responds with the FileAnalysis result.

import Parser from 'web-tree-sitter';
import { analyzeSource } from '../analyzer/sourceAnalyzer';
import type { CustomPattern, FileAnalysis, LoadedFile, TypeDict } from '../analyzer/types';

interface WorkerRequest {
  file: LoadedFile;
  typeDict: TypeDict;
  patterns: CustomPattern[];
}

interface WorkerResponse {
  type: 'result';
  analysis: FileAnalysis;
}

interface WorkerError {
  type: 'error';
  message: string;
}

let parserReady = false;
let parser: Parser | null = null;

async function ensureParser(): Promise<Parser> {
  if (parserReady && parser) return parser;
  await Parser.init({ locateFile: () => '/tree-sitter.wasm' });
  parser = new Parser();
  const C = await Parser.Language.load('/tree-sitter-c.wasm');
  parser.setLanguage(C);
  parserReady = true;
  return parser;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { file, typeDict, patterns } = event.data;
  try {
    const p = await ensureParser();
    const analysis = await analyzeSource(file, p, typeDict, patterns);
    const response: WorkerResponse = { type: 'result', analysis };
    self.postMessage(response);
  } catch (e) {
    const err: WorkerError = { type: 'error', message: String(e) };
    self.postMessage(err);
  }
};

export {};
