import type { FileZone, LoadedFile } from './types';

const MAX_SIZE_BYTES = 2 * 1024 * 1024;        // 2MB hard limit
const OVERSIZED_BYTES = 500 * 1024;             // 500KB soft limit
const BINARY_SAMPLE_SIZE = 8 * 1024;            // 8KB sample for binary detection
const BINARY_RATIO_THRESHOLD = 0.10;            // 10% non-printable

function isBinary(bytes: Uint8Array): boolean {
  const sample = bytes.slice(0, BINARY_SAMPLE_SIZE);
  let nonPrintable = 0;
  for (const byte of sample) {
    // Allow: tab (9), LF (10), CR (13), printable ASCII (32–126)
    if (byte !== 9 && byte !== 10 && byte !== 13 && (byte < 32 || byte > 126)) {
      nonPrintable++;
    }
  }
  return sample.length > 0 && nonPrintable / sample.length > BINARY_RATIO_THRESHOLD;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Directory ingest sets webkitRelativePath (e.g. sa/types.h); file picker only has name. */
export function ingestPath(file: File): string {
  const rel = file.webkitRelativePath?.replace(/\\/g, '/') ?? '';
  return rel || file.name;
}

export async function ingestFile(file: File, zone: FileZone): Promise<LoadedFile> {
  const base: Omit<LoadedFile, 'content' | 'encoding' | 'rejected' | 'rejectionReason' | 'oversized'> = {
    filename: ingestPath(file),
    zone,
    sizeBytes: file.size,
  };

  // Empty file
  if (file.size === 0) {
    return { ...base, content: '', encoding: 'utf-8', oversized: false, rejected: true, rejectionReason: 'empty file' };
  }

  // Too large
  if (file.size > MAX_SIZE_BYTES) {
    return { ...base, content: '', encoding: 'utf-8', oversized: false, rejected: true, rejectionReason: 'file too large (>2MB)' };
  }

  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // NUL in the sample means a real binary (e.g. UTF-16). UTF-8 punctuation
  // like em dashes is not binary — it decodes cleanly below.
  const sample = bytes.slice(0, BINARY_SAMPLE_SIZE);
  if (sample.includes(0)) {
    return { ...base, content: '', encoding: 'utf-8', oversized: false, rejected: true, rejectionReason: 'binary file' };
  }

  let content: string;
  let encoding: 'utf-8' | 'latin-1';
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    encoding = 'utf-8';
  } catch {
    if (isBinary(bytes)) {
      return { ...base, content: '', encoding: 'utf-8', oversized: false, rejected: true, rejectionReason: 'binary file' };
    }
    content = new TextDecoder('iso-8859-1').decode(buffer);
    encoding = 'latin-1';
  }

  content = normalizeLineEndings(content);
  const oversized = file.size >= OVERSIZED_BYTES;

  return { ...base, content, encoding, oversized, rejected: false };
}

export async function ingestFiles(files: File[], zone: FileZone): Promise<LoadedFile[]> {
  return Promise.all(files.map((f) => ingestFile(f, zone)));
}
