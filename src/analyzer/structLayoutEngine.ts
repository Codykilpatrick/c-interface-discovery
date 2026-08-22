import type { CStruct, TypeDict } from './types';
import type { PackSource } from './packDetection';

// ── Public types ───────────────────────────────────────────────────────────────

export interface CFieldLayout {
  name: string;
  type: string;
  bitWidth?: number;
  offsetBytes: number;
  sizeBytes: number;
  alignBytes: number;
  isPointer: boolean;
  isArray: boolean;
  arrayLength?: number;
  /** True when this field's type resolved to a struct in the type dictionary. */
  isStructMember?: boolean;
  /** Canonical struct type name, when `isStructMember`. */
  structTypeName?: string;
}

/** Why a run of padding bytes exists, and what forced it. */
export interface PaddingGap {
  /** Field the gap follows; null for leading padding. */
  afterField: string | null;
  /** Field the gap precedes; null for tail padding. */
  beforeField: string | null;
  offsetBytes: number;
  sizeBytes: number;
  reason: 'align-member' | 'align-struct-tail';
  /** The alignment requirement that forced the gap. */
  causedByAlign: number;
  /** The type imposing that alignment. Null for tail padding (the struct's own). */
  causedByType: string | null;
  /** True when both neighbours are embedded structs rather than scalars — a gap
   *  *between two blocks*, as distinct from ordinary intra-struct slack. */
  atCompositionBoundary: boolean;
}

export interface CStructLayout {
  name: string;
  fields: CFieldLayout[];
  totalSizeBytes: number;
  alignBytes: number;
  /** Sum of every gap in `paddingGaps`. Kept for compatibility. */
  paddingBytes: number;
  /** Located, attributed padding. Empty when the struct has no gaps. */
  paddingGaps: PaddingGap[];
  packAttribute?: number;
  packSource?: PackSource;
  isEstimated: boolean;
  sourceFile: string;
  typedefAliases: string[];
}

/** Per-struct comparison between the two layout targets. */
export interface LayoutDiff {
  name: string;
  size32: number;
  size64: number;
  padding32: number;
  padding64: number;
  differs: boolean;
  /** Fields whose offset moves between targets. */
  movedFields: { name: string; offset32: number; offset64: number }[];
}

export interface StructCatalog {
  layouts: CStructLayout[];
  typedefMap: Map<string, string>; // alias → canonical struct name
}

export interface LayoutOptions {
  target: '32bit' | '64bit';
  packOverride?: number;
}

// ── Primitive size/align tables ────────────────────────────────────────────────

const PRIM32: Record<string, [number, number]> = {
  'char':               [1, 1], 'signed char':   [1, 1], 'unsigned char':  [1, 1],
  'short':              [2, 2], 'signed short':  [2, 2], 'unsigned short': [2, 2],
  'short int':          [2, 2], 'unsigned short int': [2, 2],
  'int':                [4, 4], 'signed int':    [4, 4], 'unsigned int':   [4, 4],
  'unsigned':           [4, 4],
  'long':               [4, 4], 'signed long':   [4, 4], 'unsigned long':  [4, 4],
  'long int':           [4, 4], 'unsigned long int': [4, 4],
  'long long':          [8, 4], 'signed long long': [8, 4], 'unsigned long long': [8, 4],
  'long long int':      [8, 4], 'unsigned long long int': [8, 4],
  'float':              [4, 4], 'double':        [8, 4], 'long double':    [12, 4],
  'bool':               [1, 1], '_Bool':         [1, 1],
  'uint8_t':            [1, 1], 'int8_t':        [1, 1],
  'uint16_t':           [2, 2], 'int16_t':       [2, 2],
  'uint32_t':           [4, 4], 'int32_t':       [4, 4],
  'uint64_t':           [8, 4], 'int64_t':       [8, 4],
  'size_t':             [4, 4], 'ssize_t':       [4, 4],
  'ptrdiff_t':          [4, 4], 'intptr_t':      [4, 4], 'uintptr_t':     [4, 4],
};

const PRIM64: Record<string, [number, number]> = {
  ...PRIM32,
  'long':               [8, 8], 'signed long':   [8, 8], 'unsigned long':  [8, 8],
  'long int':           [8, 8], 'unsigned long int': [8, 8],
  'long long':          [8, 8], 'signed long long': [8, 8], 'unsigned long long': [8, 8],
  'long long int':      [8, 8], 'unsigned long long int': [8, 8],
  'long double':        [16, 16],
  'size_t':             [8, 8], 'ssize_t':       [8, 8],
  'ptrdiff_t':          [8, 8], 'intptr_t':      [8, 8], 'uintptr_t':     [8, 8],
  'uint64_t':           [8, 8], 'int64_t':       [8, 8],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function alignUp(offset: number, align: number): number {
  return align <= 1 ? offset : Math.ceil(offset / align) * align;
}

function pointerSize(target: '32bit' | '64bit'): number {
  return target === '64bit' ? 8 : 4;
}

function pointerAlign(target: '32bit' | '64bit'): number {
  return target === '64bit' ? 8 : 4;
}

/** Strip C qualifiers and collapse extra whitespace. */
function normalizeType(raw: string): string {
  return raw
    .replace(/\b(const|volatile|restrict|__restrict|__restrict__|__extension__|__attribute__\s*\([^)]*\))\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Return [size, align] for a primitive type name, or null if not found. */
function primitiveSizeAlign(
  typeName: string,
  target: '32bit' | '64bit',
): [number, number] | null {
  const table = target === '64bit' ? PRIM64 : PRIM32;
  const key = typeName.replace(/^(signed|unsigned)\s+/, (m) => m).toLowerCase();
  return table[key] ?? table[typeName.toLowerCase()] ?? null;
}

/**
 * Read packing detected at parse time by `packDetection.ts` (`__attribute__((packed))`
 * or an enclosing `#pragma pack(N)`), recorded on the struct by `headerParser`.
 */
function detectPackAttribute(struct: CStruct): number | undefined {
  return struct.packAttribute;
}

// ── Typedef resolution ────────────────────────────────────────────────────────

/** Build a map from typedef aliases to canonical struct names. */
function buildTypedefMap(typeDict: TypeDict): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of typeDict.structs) {
    map.set(s.name, s.name);
  }
  // Include plain typedef aliases from headerParser (e.g. PASSBACK → DIST_PASSBACK)
  if (typeDict.typedefAliases) {
    for (const [alias, canonical] of Object.entries(typeDict.typedefAliases)) {
      if (!map.has(alias)) {
        // Chase the chain up to 4 hops
        let resolved = canonical;
        for (let i = 0; i < 4; i++) {
          if (map.has(resolved)) { map.set(alias, map.get(resolved)!); break; }
          const next = typeDict.typedefAliases[resolved];
          if (!next || next === resolved) { map.set(alias, resolved); break; }
          resolved = next;
        }
      }
    }
  }
  return map;
}

/**
 * Follow a typedef chain looking for a primitive. System headers alias several
 * levels deep (`time_t` → `__time_t` → `long`), and without this the type falls
 * through to the unknown-type branch and silently takes pointer size.
 */
function chaseAliasToPrimitive(
  typeName: string,
  typeDict: TypeDict,
  target: '32bit' | '64bit',
): [number, number] | null {
  const aliases = typeDict.typedefAliases;
  if (!aliases) return null;
  let name = typeName;
  for (let hops = 0; hops < 6; hops++) {
    const next = aliases[name];
    if (!next || next === name) return null;
    // A chain that lands on a struct is not our business — the caller resolves it.
    if (typeDict.structs.some((s) => s.name === next)) return null;
    const prim = primitiveSizeAlign(next, target);
    if (prim) return prim;
    name = next;
  }
  return null;
}

/** Resolve a type name through typedef aliases to find a struct. */
function resolveToStruct(
  typeName: string,
  typeDict: TypeDict,
  typedefMap: Map<string, string>,
): CStruct | null {
  const canonical = typedefMap.get(typeName) ?? typeName;
  return typeDict.structs.find((s) => s.name === canonical) ?? null;
}

// ── Field type parsing ────────────────────────────────────────────────────────

interface ParsedFieldType {
  baseType: string;       // innermost type after stripping *, []
  isPointer: boolean;
  isArray: boolean;
  arrayLength?: number;
  isBitfield: boolean;
  bitWidth?: number;
}

function parseFieldType(rawType: string, rawName: string): ParsedFieldType {
  let base = normalizeType(rawType);
  let isPointer = false;
  let isArray = false;
  let arrayLength: number | undefined;
  let isBitfield = false;
  let bitWidth: number | undefined;

  // Pointer detection: type contains * or name starts with *
  if (base.includes('*') || rawName.startsWith('*')) {
    isPointer = true;
    base = base.replace(/\*/g, '').trim();
  }

  // Bitfield: type string contains ':N' pattern (from field declarations like `unsigned x : 3`)
  const bitfieldMatch = base.match(/:(\s*\d+)\s*$/);
  if (bitfieldMatch) {
    isBitfield = true;
    bitWidth = parseInt(bitfieldMatch[1].trim(), 10);
    base = base.replace(/:\s*\d+\s*$/, '').trim();
  }

  // Array: look for [N] in name (e.g. `char name[32]`) or in type. Multiply every
  // extent so `char grid[2][3]` counts 6 elements, not 2.
  const extents = [...(rawName + base).matchAll(/\[(\d+)\]/g)].map((m) => parseInt(m[1], 10));
  if (extents.length > 0) {
    isArray = true;
    arrayLength = extents.reduce((a, b) => a * b, 1);
    base = base.replace(/\[\d+\]/g, '').trim();
  }

  // Strip struct/union/enum keywords
  base = base.replace(/^(struct|union|enum)\s+/, '').trim();

  return { baseType: base, isPointer, isArray, arrayLength, isBitfield, bitWidth };
}

// ── Core layout computation ───────────────────────────────────────────────────

const RECURSION_GUARD = new Set<string>();

function computeLayoutInternal(
  struct: CStruct,
  typeDict: TypeDict,
  typedefMap: Map<string, string>,
  opts: LayoutOptions,
  packValue: number,
): Omit<CStructLayout, 'name' | 'sourceFile' | 'typedefAliases' | 'packAttribute' | 'packSource'> {
  const ptrSize = pointerSize(opts.target);
  const ptrAlign = pointerAlign(opts.target);

  const fieldLayouts: CFieldLayout[] = [];
  const paddingGaps: PaddingGap[] = [];
  let offset = 0;
  let structAlign = 1;
  let isEstimated = false;
  let internalPaddingBytes = 0;

  /** Record a gap, attributing it to the member whose alignment forced it. */
  function recordGap(
    from: number,
    to: number,
    beforeField: string,
    causedByAlign: number,
    causedByType: string | null,
    nextIsStruct: boolean,
  ) {
    if (to <= from) return;
    const prev = fieldLayouts[fieldLayouts.length - 1];
    paddingGaps.push({
      afterField: prev?.name ?? null,
      beforeField,
      offsetBytes: from,
      sizeBytes: to - from,
      reason: 'align-member',
      causedByAlign,
      causedByType,
      atCompositionBoundary: Boolean(prev?.isStructMember) && nextIsStruct,
    });
  }

  for (const field of struct.fields) {
    const parsed = parseFieldType(field.type, field.name);
    const { baseType, isPointer, isArray, arrayLength, isBitfield, bitWidth } = parsed;

    let fieldSize: number;
    let fieldAlign: number;
    let structTypeName: string | undefined;

    if (isPointer) {
      // A pointer is a machine word regardless of what it points at, so a
      // pointer to a struct is *not* a composition boundary — and it means the
      // struct is not flat-serializable.
      fieldSize = ptrSize;
      fieldAlign = ptrAlign;
    } else {
      // Try primitives first, then chase typedef chains to a primitive.
      // System headers alias heavily (`time_t` → `__time_t` → `long`), and a
      // missed chain silently substitutes pointer size — which would make every
      // offset below it wrong.
      const prim =
        primitiveSizeAlign(baseType, opts.target) ??
        chaseAliasToPrimitive(baseType, typeDict, opts.target);
      if (prim) {
        [fieldSize, fieldAlign] = prim;
      } else {
        // Try nested struct
        const nestedStruct = resolveToStruct(baseType, typeDict, typedefMap);
        if (nestedStruct && !RECURSION_GUARD.has(nestedStruct.name)) {
          RECURSION_GUARD.add(nestedStruct.name);
          try {
            // A packed parent propagates its packing into nested members.
            const nestedPack = Math.min(packValue, nestedStruct.packAttribute ?? packValue);
            const nested = computeLayoutInternal(nestedStruct, typeDict, typedefMap, opts, nestedPack);
            fieldSize = nested.totalSizeBytes;
            fieldAlign = nested.alignBytes;
            structTypeName = nestedStruct.name;
            if (nested.isEstimated) isEstimated = true;
          } finally {
            RECURSION_GUARD.delete(nestedStruct.name);
          }
        } else {
          // Unknown type — use pointer size and flag as estimated
          fieldSize = ptrSize;
          fieldAlign = ptrAlign;
          isEstimated = true;
        }
      }
    }

    if (isBitfield && bitWidth !== undefined) {
      // Simplified bitfield: allocate storage unit of fieldAlign size if needed
      const bitContainer = fieldSize;
      const effectiveAlign = Math.min(fieldAlign, packValue);
      const aligned = alignUp(offset, effectiveAlign);
      recordGap(offset, aligned, field.name, effectiveAlign, field.type, false);
      internalPaddingBytes += aligned - offset;
      offset = aligned;
      fieldLayouts.push({
        name: field.name,
        type: field.type,
        bitWidth,
        offsetBytes: offset,
        sizeBytes: bitContainer,
        alignBytes: effectiveAlign,
        isPointer: false,
        isArray: false,
      });
      offset += bitContainer;
      structAlign = Math.max(structAlign, effectiveAlign);
      continue;
    }

    const effectiveAlign = Math.min(fieldAlign, packValue);
    const aligned = alignUp(offset, effectiveAlign);
    recordGap(offset, aligned, field.name, effectiveAlign, structTypeName ?? baseType, structTypeName !== undefined);
    internalPaddingBytes += aligned - offset;
    offset = aligned;
    structAlign = Math.max(structAlign, effectiveAlign);

    const elementSize = fieldSize;
    const totalSize = isArray ? elementSize * (arrayLength ?? 1) : elementSize;

    fieldLayouts.push({
      name: field.name,
      type: field.type,
      offsetBytes: offset,
      sizeBytes: totalSize,
      alignBytes: effectiveAlign,
      isPointer,
      isArray,
      ...(arrayLength !== undefined && { arrayLength }),
      ...(structTypeName !== undefined && { isStructMember: true, structTypeName }),
    });

    offset += totalSize;
  }

  // Final struct size is padded to struct alignment
  const totalSizeBytes = alignUp(offset, structAlign);
  if (totalSizeBytes > offset) {
    paddingGaps.push({
      afterField: fieldLayouts[fieldLayouts.length - 1]?.name ?? null,
      beforeField: null,
      offsetBytes: offset,
      sizeBytes: totalSizeBytes - offset,
      reason: 'align-struct-tail',
      causedByAlign: structAlign,
      causedByType: null,
      atCompositionBoundary: false,
    });
  }
  // paddingBytes = internal gaps + tail padding
  const paddingBytes = internalPaddingBytes + (totalSizeBytes - offset);

  return {
    fields: fieldLayouts,
    totalSizeBytes,
    alignBytes: structAlign,
    paddingBytes,
    paddingGaps,
    isEstimated,
  };
}

/** Compute the memory layout of a single struct. */
export function computeLayout(
  struct: CStruct,
  typeDict: TypeDict,
  opts: LayoutOptions,
): CStructLayout {
  const typedefMap = buildTypedefMap(typeDict);
  const packAttr = detectPackAttribute(struct);
  const packValue = opts.packOverride ?? packAttr ?? (opts.target === '64bit' ? 8 : 4);

  RECURSION_GUARD.clear();
  RECURSION_GUARD.add(struct.name);
  const result = computeLayoutInternal(struct, typeDict, typedefMap, opts, packValue);
  RECURSION_GUARD.delete(struct.name);

  return {
    name: struct.name,
    ...result,
    packAttribute: packAttr,
    ...(struct.packSource !== undefined && { packSource: struct.packSource }),
    sourceFile: struct.sourceFile,
    typedefAliases: [],
  };
}

/** Build the full struct catalog from a TypeDict. */
export function buildStructCatalog(
  typeDict: TypeDict,
  opts: LayoutOptions,
): StructCatalog {
  const typedefMap = buildTypedefMap(typeDict);
  const layouts: CStructLayout[] = [];

  for (const struct of typeDict.structs) {
    if (struct.fields.length === 0) continue; // skip opaque/forward-declared structs

    const packAttr = detectPackAttribute(struct);
    const packValue = opts.packOverride ?? packAttr ?? (opts.target === '64bit' ? 8 : 4);

    RECURSION_GUARD.clear();
    RECURSION_GUARD.add(struct.name);
    const result = computeLayoutInternal(struct, typeDict, typedefMap, opts, packValue);
    RECURSION_GUARD.delete(struct.name);

    layouts.push({
      name: struct.name,
      ...result,
      packAttribute: packAttr,
      ...(struct.packSource !== undefined && { packSource: struct.packSource }),
      sourceFile: struct.sourceFile,
      typedefAliases: [],
    });
  }

  return { layouts, typedefMap };
}
