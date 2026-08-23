/** Escape regex metacharacters so a name can be embedded in a pattern literally. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
