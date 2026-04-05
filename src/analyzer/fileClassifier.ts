import type { FileRole, LoadedFile } from './types';

export function classifyFile(file: LoadedFile): FileRole {
  const lower = file.filename.toLowerCase();
  if (/\.(c|cpp)$/.test(lower)) {
    return 'source';
  }
  if (/\.h$/.test(lower)) {
    return file.zone === 'external' ? 'external-header' : 'string-header';
  }
  // Default: treat unknown extensions in string zone as source
  return 'source';
}
