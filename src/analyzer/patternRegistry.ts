import type { CustomPattern, IpcType } from './types';

export const STORAGE_KEY = 'cid_custom_patterns';

function uuid(): string {
  // Use crypto.randomUUID if available (modern browsers), else fallback
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class PatternRegistry {
  private patterns: Map<string, CustomPattern> = new Map();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed: CustomPattern[] = JSON.parse(raw);
      for (const p of parsed) {
        this.patterns.set(p.id, p);
      }
    } catch {
      // Corrupt storage — start fresh
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.getAll()));
    } catch {
      // Storage quota exceeded or unavailable — ignore
    }
  }

  getAll(): CustomPattern[] {
    return [...this.patterns.values()];
  }

  add(pattern: Omit<CustomPattern, 'id'>): CustomPattern {
    const newPattern: CustomPattern = { ...pattern, id: uuid() };
    this.patterns.set(newPattern.id, newPattern);
    this.save();
    return newPattern;
  }

  update(id: string, changes: Partial<Omit<CustomPattern, 'id'>>): void {
    const existing = this.patterns.get(id);
    if (!existing) return;
    this.patterns.set(id, { ...existing, ...changes });
    this.save();
  }

  remove(id: string): void {
    this.patterns.delete(id);
    this.save();
  }

  /**
   * Merge patterns from JSON import. Deduplicates by name (imported wins
   * only if the name doesn't already exist).
   */
  importPatterns(imported: CustomPattern[]): void {
    const existingNames = new Set(this.getAll().map((p) => p.name));
    for (const p of imported) {
      if (!existingNames.has(p.name)) {
        const newId = uuid();
        this.patterns.set(newId, { ...p, id: newId });
        existingNames.add(p.name);
      }
    }
    this.save();
  }

  /** Returns patterns serialized as JSON string for file download. */
  exportAsJson(): string {
    return JSON.stringify(this.getAll(), null, 2);
  }

  /**
   * Count how many times each pattern matches across the provided source texts.
   * Returns a Map<patternId, count>.
   */
  countMatches(sourceTexts: string[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const pattern of this.getAll()) {
      let total = 0;
      try {
        const re = new RegExp(pattern.pattern, 'g');
        for (const text of sourceTexts) {
          const m = text.match(re);
          if (m) total += m.length;
        }
      } catch {
        // Invalid regex
      }
      counts.set(pattern.id, total);
    }
    return counts;
  }
}

export function makeDefaultPattern(
  name: string,
  pattern: string,
  ipcType: IpcType
): Omit<CustomPattern, 'id'> {
  return {
    name,
    pattern,
    ipcType,
    direction: 'bidirectional',
    notes: '',
  };
}
