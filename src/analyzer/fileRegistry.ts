import type {
  AnalysisWarning,
  FileRegistryEntry,
  FileZone,
  LoadedFile,
} from './types';

/** Unique key combining filename + zone. */
function key(filename: string, zone: FileZone): string {
  return `${zone}::${filename}`;
}

export class FileRegistry {
  private entries: Map<string, FileRegistryEntry> = new Map();
  private _warnings: AnalysisWarning[] = [];

  /**
   * Add or replace files. String zone wins over external zone on filename collision.
   * Same-zone additions silently replace the existing entry.
   */
  addFiles(files: LoadedFile[]): void {
    for (const file of files) {
      const k = key(file.filename, file.zone);
      const oppositeZone: FileZone = file.zone === 'string' ? 'external' : 'string';
      const oppositeKey = key(file.filename, oppositeZone);

      // Same-zone replacement — silent, no warning
      this.entries.set(k, { file });

      // Check for cross-zone collision
      if (this.entries.has(oppositeKey)) {
        const winner = file.zone === 'string' ? file.filename : (this.entries.get(k)!.file.filename);

        if (file.zone === 'string') {
          // String zone wins: shadow the external entry
          const externalEntry = this.entries.get(oppositeKey)!;
          this.entries.set(oppositeKey, {
            file: externalEntry.file,
            shadowedBy: file.filename,
          });
        } else {
          // External zone loses: shadow this entry
          this.entries.set(k, { file, shadowedBy: winner });
        }

        // Emit or update collision warning (deduplicate by filename)
        const existing = this._warnings.find(
          (w) => w.kind === 'collision' && w.files.includes(file.filename)
        );
        if (!existing) {
          this._warnings.push({
            kind: 'collision',
            message: `${file.filename} exists in both zones — local version takes precedence`,
            files: [file.filename],
          });
        }
      }
    }
  }

  /** Remove a file by filename + zone, clear its shadow status from the opposite zone. */
  removeFile(filename: string, zone: FileZone): void {
    const k = key(filename, zone);
    this.entries.delete(k);

    // If opposite-zone version was shadowed by this file, unshadow it
    const oppositeZone: FileZone = zone === 'string' ? 'external' : 'string';
    const oppositeKey = key(filename, oppositeZone);
    const oppositeEntry = this.entries.get(oppositeKey);
    if (oppositeEntry?.shadowedBy === filename) {
      this.entries.set(oppositeKey, { file: oppositeEntry.file });
    }

    // Remove collision warning for this filename
    this._warnings = this._warnings.filter(
      (w) => !(w.kind === 'collision' && w.files.includes(filename))
    );
  }

  /** All non-rejected, non-shadowed files. */
  getAll(): LoadedFile[] {
    return [...this.entries.values()]
      .filter((e) => !e.shadowedBy && !e.file.rejected)
      .map((e) => e.file);
  }

  /** .c / .cpp files from the string zone only. */
  getSources(): LoadedFile[] {
    return this.getAll().filter(
      (f) => f.zone === 'string' && /\.(c|cpp)$/i.test(f.filename)
    );
  }

  /** .h files from the string zone. */
  getStringHeaders(): LoadedFile[] {
    return this.getAll().filter(
      (f) => f.zone === 'string' && /\.h$/i.test(f.filename)
    );
  }

  /** .h files from the external zone. */
  getExternalHeaders(): LoadedFile[] {
    return this.getAll().filter(
      (f) => f.zone === 'external' && /\.h$/i.test(f.filename)
    );
  }

  /** All entries including shadowed and rejected (for display in FileList). */
  getAllEntries(): FileRegistryEntry[] {
    return [...this.entries.values()];
  }

  get warnings(): AnalysisWarning[] {
    return this._warnings;
  }

  clear(): void {
    this.entries.clear();
    this._warnings = [];
  }
}
