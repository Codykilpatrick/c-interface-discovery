/**
 * Struct packing detection.
 *
 * Layout arithmetic is only correct if we know whether a struct is packed —
 * packing is precisely the mechanism that removes the padding the layout engine
 * reports. Two sources, both handled here:
 *
 *   1. `#pragma pack(N)` / `push` / `pop` — lexically scoped, affects every struct
 *      declared while it is in effect.
 *   2. `__attribute__((packed))` — attached to one struct declaration.
 *
 * Reporting confident byte offsets for a struct that is actually packed is worse
 * than reporting nothing, so callers must treat "detection did not run" and
 * "detection found nothing" as different states.
 */

export type PackSource = 'attribute' | 'pragma';

/** A `#pragma pack(...)` occurrence, 0-based line. */
export interface PackDirective {
  line: number;
  kind: 'set' | 'push' | 'pop' | 'reset';
  value?: number;
}

const PRAGMA_RE = /^[ \t]*#[ \t]*pragma[ \t]+pack[ \t]*\(([^)]*)\)/;

/** Scan `#pragma pack` directives in source order. Exported for testing. */
export function scanPackPragmas(content: string): PackDirective[] {
  const out: PackDirective[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const m = PRAGMA_RE.exec(lines[i]);
    if (!m) continue;

    const args = m[1].trim();
    if (args === '') {
      out.push({ line: i, kind: 'reset' });
      continue;
    }

    const parts = args.split(',').map((p) => p.trim()).filter(Boolean);
    const head = parts[0]?.toLowerCase();

    if (head === 'pop') {
      out.push({ line: i, kind: 'pop' });
    } else if (head === 'push') {
      // `push` alone pushes the current value; `push, N` pushes and sets N.
      const n = parts[1] !== undefined ? Number(parts[1]) : undefined;
      out.push({ line: i, kind: 'push', ...(isPackValue(n) && { value: n }) });
    } else {
      const n = Number(parts[0]);
      // `#pragma pack(0)` and unparseable values reset to the default.
      out.push(isPackValue(n) ? { line: i, kind: 'set', value: n } : { line: i, kind: 'reset' });
    }
  }
  return out;
}

/** Pack values are powers of two, 1..16 in practice. */
function isPackValue(n: number | undefined): n is number {
  return n !== undefined && Number.isInteger(n) && n > 0 && n <= 16 && (n & (n - 1)) === 0;
}

/**
 * Resolve the `#pragma pack` value in effect at each line by replaying the
 * directive stream. Returns a lookup; `undefined` means "no pragma in effect"
 * (natural alignment), which is distinct from a pragma that set a value.
 */
export function buildPackMap(content: string): (line: number) => number | undefined {
  const directives = scanPackPragmas(content);
  if (directives.length === 0) return () => undefined;

  // Replay into a sorted list of [fromLine, value] checkpoints.
  const checkpoints: { line: number; value: number | undefined }[] = [];
  const stack: (number | undefined)[] = [];
  let current: number | undefined;

  for (const d of directives) {
    switch (d.kind) {
      case 'set':   current = d.value; break;
      case 'reset': current = undefined; break;
      case 'push':
        stack.push(current);
        if (d.value !== undefined) current = d.value;
        break;
      case 'pop':
        current = stack.length > 0 ? stack.pop() : undefined;
        break;
    }
    checkpoints.push({ line: d.line, value: current });
  }

  return (line: number) => {
    let value: number | undefined;
    for (const cp of checkpoints) {
      if (cp.line > line) break;
      value = cp.value;
    }
    return value;
  };
}

/** `__packed` is a common vendor shorthand with no argument list. */
const PACKED_SHORTHAND_RE = /\b__packed\b/;
const PACKED_KEYWORD_RE = /\b(?:packed|__packed__)\b/;

/**
 * Extract the balanced parenthesized group starting at `open`, which must index
 * a `(`. Returns the inner text, or null if the parens never close.
 *
 * A regex cannot do this: `__attribute__((aligned(1), packed))` nests, so a
 * `[^)]*` scan stops at the wrong paren and misses the `packed`.
 */
function balancedGroup(text: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * Detect `__attribute__((packed))` on a struct declaration.
 *
 * `declText` should span the whole declaration — GCC accepts the attribute
 * before the struct keyword, after the closing brace, and after the declarator.
 */
export function detectPackedAttribute(declText: string): number | undefined {
  if (PACKED_SHORTHAND_RE.test(declText)) return 1;

  const ATTR = '__attribute__';
  for (let i = declText.indexOf(ATTR); i !== -1; i = declText.indexOf(ATTR, i + 1)) {
    let j = i + ATTR.length;
    while (j < declText.length && /\s/.test(declText[j])) j++;
    if (declText[j] !== '(') continue;
    const inner = balancedGroup(declText, j);
    if (inner !== null && PACKED_KEYWORD_RE.test(inner)) return 1;
  }
  return undefined;
}

/**
 * Combine both sources for one struct declaration. `__attribute__((packed))`
 * is byte-packing and always wins over a pragma, being the more restrictive.
 */
export function resolvePack(
  declText: string,
  pragmaValue: number | undefined,
): { packAttribute: number; packSource: PackSource } | undefined {
  const attr = detectPackedAttribute(declText);
  if (attr !== undefined) return { packAttribute: attr, packSource: 'attribute' };
  if (pragmaValue !== undefined) return { packAttribute: pragmaValue, packSource: 'pragma' };
  return undefined;
}
