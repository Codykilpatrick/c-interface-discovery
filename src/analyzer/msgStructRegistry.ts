import type { MsgStructPattern } from './types';

export const MSG_STRUCT_STORAGE_KEY = 'cid_msg_struct_patterns';

function uuid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class MsgStructRegistry {
  private patterns: Map<string, MsgStructPattern> = new Map();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(MSG_STRUCT_STORAGE_KEY);
      if (!raw) return;
      const parsed: MsgStructPattern[] = JSON.parse(raw);
      for (const p of parsed) {
        this.patterns.set(p.id, p);
      }
    } catch {
      // Corrupt storage — start fresh
    }
  }

  private save(): void {
    try {
      localStorage.setItem(MSG_STRUCT_STORAGE_KEY, JSON.stringify(this.getAll()));
    } catch {
      // Storage quota exceeded or unavailable — ignore
    }
  }

  getAll(): MsgStructPattern[] {
    return [...this.patterns.values()];
  }

  add(pattern: Omit<MsgStructPattern, 'id'>): MsgStructPattern {
    const newPattern: MsgStructPattern = { ...pattern, id: uuid() };
    this.patterns.set(newPattern.id, newPattern);
    this.save();
    return newPattern;
  }

  update(id: string, changes: Partial<Omit<MsgStructPattern, 'id'>>): void {
    const existing = this.patterns.get(id);
    if (!existing) return;
    this.patterns.set(id, { ...existing, ...changes });
    this.save();
  }

  remove(id: string): void {
    this.patterns.delete(id);
    this.save();
  }

  clear(): void {
    this.patterns.clear();
    this.save();
  }

  importPatterns(imported: MsgStructPattern[]): void {
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

  exportAsJson(): string {
    return JSON.stringify(this.getAll(), null, 2);
  }
}
