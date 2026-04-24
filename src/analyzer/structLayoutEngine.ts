import type { CStruct, TypeDict } from './types';

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
}

export interface CStructLayout {
  name: string;
  fields: CFieldLayout[];
  totalSizeBytes: number;
  alignBytes: number;
  paddingBytes: number;
  packAttribute?: number;
  isEstimated: boolean;
  sourceFile: string;
  typedefAliases: string[];
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

/** Detect `__attribute__((packed))` or `__packed__` on a struct's raw source. */
function detectPackAttribute(struct: CStruct, typeDict: TypeDict): number | undefined {
  // We don't have the raw text easily, but we can check if the struct was
  // derived from any field patterns that suggest packing. For now we return
  // undefined (no packing detected), since we rely on CStruct.fields which
  // already have type info but not the raw attribute text.
  // This is a best-effort implementation; actual packed detection requires
  // the raw source text which isn't stored on CStruct.
  void struct; void typeDict;
  return undefined;
}

// ── Typedef resolution ────────────────────────────────────────────────────────

/** Build a map from typedef aliases to canonical struct names. */
function buildTypedefMap(typeDict: TypeDict): Map<string, string> {
  const map = new Map<string, string>();
  // Every struct name is its own canonical form
  for (const s of typeDict.structs) {
    map.set(s.name, s.name);
  }
  // For typedefs: if a typedef name matches a struct name, it's an alias
  // The headerParser stores typedefs implicitly: when a `typedef struct Foo Bar`
  // is parsed, the struct gets name "Foo" and it's also referenced as "Bar".
  // We look for structs that were parsed from typedef_name captures.
  // Since CStruct doesn't store typedef info directly, we scan all struct names
  // and look for ones that might be typedef aliases for other structs.
  // Heuristic: if there are two structs with the same fields but different names,
  // one is likely a typedef of the other. We can't resolve this perfectly without
  // full AST info, so we just ensure struct names resolve to themselves.
  return map;
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

  // Array: look for [N] in name (e.g. `char name[32]`) or in type
  const arrayMatch = (rawName + base).match(/\[(\d+)\]/);
  if (arrayMatch) {
    isArray = true;
    arrayLength = parseInt(arrayMatch[1], 10);
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
): Omit<CStructLayout, 'name' | 'sourceFile' | 'typedefAliases' | 'packAttribute'> {
  const ptrSize = pointerSize(opts.target);
  const ptrAlign = pointerAlign(opts.target);

  const fieldLayouts: CFieldLayout[] = [];
  let offset = 0;
  let structAlign = 1;
  let isEstimated = false;
  let internalPaddingBytes = 0;

  for (const field of struct.fields) {
    const parsed = parseFieldType(field.type, field.name);
    const { baseType, isPointer, isArray, arrayLength, isBitfield, bitWidth } = parsed;

    let fieldSize: number;
    let fieldAlign: number;

    if (isPointer) {
      fieldSize = ptrSize;
      fieldAlign = ptrAlign;
    } else {
      // Try primitives first
      const prim = primitiveSizeAlign(baseType, opts.target);
      if (prim) {
        [fieldSize, fieldAlign] = prim;
      } else {
        // Try nested struct
        const nestedStruct = resolveToStruct(baseType, typeDict, typedefMap);
        if (nestedStruct && !RECURSION_GUARD.has(nestedStruct.name)) {
          RECURSION_GUARD.add(nestedStruct.name);
          try {
            const nested = computeLayoutInternal(nestedStruct, typeDict, typedefMap, opts, packValue);
            fieldSize = nested.totalSizeBytes;
            fieldAlign = nested.alignBytes;
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
    });

    offset += totalSize;
  }

  // Final struct size is padded to struct alignment
  const totalSizeBytes = alignUp(offset, structAlign);
  // paddingBytes = internal gaps + tail padding
  const paddingBytes = internalPaddingBytes + (totalSizeBytes - offset);

  return { fields: fieldLayouts, totalSizeBytes, alignBytes: structAlign, paddingBytes, isEstimated };
}

/** Compute the memory layout of a single struct. */
export function computeLayout(
  struct: CStruct,
  typeDict: TypeDict,
  opts: LayoutOptions,
): CStructLayout {
  const typedefMap = buildTypedefMap(typeDict);
  const packAttr = detectPackAttribute(struct, typeDict);
  const packValue = opts.packOverride ?? packAttr ?? (opts.target === '64bit' ? 8 : 4);

  RECURSION_GUARD.clear();
  RECURSION_GUARD.add(struct.name);
  const result = computeLayoutInternal(struct, typeDict, typedefMap, opts, packValue);
  RECURSION_GUARD.delete(struct.name);

  return {
    name: struct.name,
    ...result,
    packAttribute: packAttr,
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

    const packAttr = detectPackAttribute(struct, typeDict);
    const packValue = opts.packOverride ?? packAttr ?? (opts.target === '64bit' ? 8 : 4);

    RECURSION_GUARD.clear();
    RECURSION_GUARD.add(struct.name);
    const result = computeLayoutInternal(struct, typeDict, typedefMap, opts, packValue);
    RECURSION_GUARD.delete(struct.name);

    layouts.push({
      name: struct.name,
      ...result,
      packAttribute: packAttr,
      sourceFile: struct.sourceFile,
      typedefAliases: [],
    });
  }

  return { layouts, typedefMap };
}
