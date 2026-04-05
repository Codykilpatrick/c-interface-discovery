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

export async function ingestFile(file: File, zone: FileZone): Promise<LoadedFile> {
  const base: Omit<LoadedFile, 'content' | 'encoding' | 'rejected' | 'rejectionReason' | 'oversized'> = {
    filename: file.name,
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

  // Binary detection
  if (isBinary(bytes)) {
    return { ...base, content: '', encoding: 'utf-8', oversized: false, rejected: true, rejectionReason: 'binary file' };
  }

  // Encoding detection
  let content: string;
  let encoding: 'utf-8' | 'latin-1';
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    encoding = 'utf-8';
  } catch {
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
