/** Reject patterns that will freeze the tab when run on a large corpus. */

const MAX_PATTERN = 200;

export function regexTooDangerous(pattern: string): string | null {
  if (pattern.length > MAX_PATTERN) return 'Pattern is too long';
  // Nested quantifiers like `(a+)+` are the classic catastrophic-backtrack shape.
  if (/\([^)]*[+*][^)]*\)[+*]/.test(pattern)) return 'Pattern has nested quantifiers';
  return null;
}
