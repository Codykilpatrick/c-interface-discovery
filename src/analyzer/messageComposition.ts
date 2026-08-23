/**
 * Message composition — the top-down, per-message render.
 *
 *   MSG_TYPE_CONTACT → ContactMsg = CicHeader + pad(4) + FusedContact + sockaddr_in
 *
 * Struct roles answer "what contains this struct?" (bottom-up) and the layout
 * engine answers "where are the bytes?". Neither produces the sentence above,
 * which is what an analyst actually reads.
 *
 * This is a *projection* over `messageInterfaces` + `structRoles` + `structCatalog`
 * — no parsing and no independent source of truth, so it cannot drift from the
 * layout engine.
 */

import type { MessageInterface, TypeDict } from './types';
import type { CStructLayout, LayoutOptions, StructCatalog } from './structLayoutEngine';
import { buildStructCatalog } from './structLayoutEngine';
import type { StructRole, StructRoleReport } from './structRoleAnalyzer';

export type LayoutTarget = '32bit' | '64bit';

export interface CompositionPart {
  kind: 'block' | 'scalar' | 'padding';
  /** Field name; null for padding. */
  name: string | null;
  /** Struct type, for `kind: 'block'`. */
  typeName: string | null;
  offsetBytes: number;
  sizeBytes: number;
  /** Role of `typeName`, for blocks. */
  role?: StructRole;
  /** Array length when the block is embedded as an array (a batch). */
  arrayLength?: number;
  /** For padding: the alignment that forced it, and the type imposing it. */
  causedByAlign?: number;
  causedByType?: string | null;
  /** For padding: sits between two embedded blocks rather than scalars. */
  atCompositionBoundary?: boolean;
  children?: CompositionPart[];
}

export interface MessageComposition {
  msgConstant: string;
  msgTypeValue: string;
  rootStruct: string;
  sourceFile: string;
  sizeByTarget: Record<LayoutTarget, number>;
  paddingByTarget: Record<LayoutTarget, number>;
  /** True when the wire size differs between targets — a portability hazard. */
  differsAcrossTargets: boolean;
  /** Layout could not be fully resolved (unknown member types). */
  isEstimated: boolean;
  /** Packing was detected on the root struct. */
  packAttribute?: number;
  /** Ordered parts at the target used for `parts`, padding included. */
  parts: CompositionPart[];
  /** Pointer members anywhere in the tree — not flat-serializable. */
  pointerWarnings: string[];
  /** Variable-length arrays anywhere in the tree — length is a macro, size is unknown. */
  variableArrayWarnings: string[];
}

export interface MessageCompositionInput {
  messageInterfaces: MessageInterface[];
  structRoles: StructRoleReport;
  typeDict: TypeDict;
  /** Catalog for the primary render target. */
  catalog: StructCatalog;
  target: LayoutTarget;
  /** Depth cap for the expanded tree. */
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 6;

function layoutOf(catalog: StructCatalog, name: string): CStructLayout | undefined {
  return catalog.layouts.find((l) => l.name === name);
}

/**
 * Build the ordered part list for one struct: fields and padding gaps merged
 * into a single offset-sorted sequence, so a gap is a row rather than an
 * implied jump between offsets.
 *
 * `base` is the absolute offset of this struct within the message, so every
 * part reports where it lands *on the wire* rather than within its own parent.
 * A reader debugging a byte dump should not have to sum the chain themselves.
 */
function partsOf(
  structName: string,
  catalog: StructCatalog,
  roles: StructRoleReport,
  depth: number,
  maxDepth: number,
  seen: Set<string>,
  base: number,
): CompositionPart[] {
  const layout = layoutOf(catalog, structName);
  if (!layout) return [];

  const parts: CompositionPart[] = [];

  for (const f of layout.fields) {
    if (f.isStructMember && f.structTypeName) {
      const childRole = roles.byName.get(f.structTypeName)?.role;
      const part: CompositionPart = {
        kind: 'block',
        name: f.name,
        typeName: f.structTypeName,
        offsetBytes: base + f.offsetBytes,
        sizeBytes: f.sizeBytes,
        ...(childRole !== undefined && { role: childRole }),
        ...(f.arrayLength !== undefined && { arrayLength: f.arrayLength }),
      };
      // Recurse, guarding against cycles and runaway depth.
      if (depth < maxDepth && !seen.has(f.structTypeName)) {
        const children = partsOf(
          f.structTypeName,
          catalog,
          roles,
          depth + 1,
          maxDepth,
          new Set([...seen, f.structTypeName]),
          base + f.offsetBytes,
        );
        if (children.length > 0) part.children = children;
      }
      parts.push(part);
    } else {
      parts.push({
        kind: 'scalar',
        name: f.name,
        typeName: null,
        offsetBytes: base + f.offsetBytes,
        sizeBytes: f.sizeBytes,
      });
    }
  }

  for (const gap of layout.paddingGaps) {
    parts.push({
      kind: 'padding',
      name: null,
      typeName: null,
      offsetBytes: base + gap.offsetBytes,
      sizeBytes: gap.sizeBytes,
      causedByAlign: gap.causedByAlign,
      causedByType: gap.causedByType,
      atCompositionBoundary: gap.atCompositionBoundary,
    });
  }

  // Offset order is the wire order. Ties break padding-first: a gap at offset N
  // precedes the field that starts at N.
  parts.sort(
    (a, b) =>
      a.offsetBytes - b.offsetBytes ||
      (a.kind === 'padding' ? -1 : 0) - (b.kind === 'padding' ? -1 : 0),
  );
  return parts;
}

/** Walk the containment tree collecting warnings from every reachable block. */
function collectWarnings(
  structName: string,
  roles: StructRoleReport,
  seen: Set<string> = new Set(),
): { pointers: string[]; variableArrays: string[] } {
  if (seen.has(structName)) return { pointers: [], variableArrays: [] };
  seen.add(structName);

  const info = roles.byName.get(structName);
  if (!info) return { pointers: [], variableArrays: [] };

  const pointers = info.pointerFields.map((f) => `${structName}.${f}`);
  const variableArrays = info.variableArrayFields.map((f) => `${structName}.${f}`);

  for (const child of info.contains) {
    const sub = collectWarnings(child, roles, seen);
    pointers.push(...sub.pointers);
    variableArrays.push(...sub.variableArrays);
  }
  return { pointers, variableArrays };
}

export function buildMessageCompositions(
  input: MessageCompositionInput,
): MessageComposition[] {
  const {
    messageInterfaces,
    structRoles,
    typeDict,
    catalog,
    target,
    maxDepth = DEFAULT_MAX_DEPTH,
  } = input;

  // The other target, for the portability diff. Built once, not per message.
  const otherTarget: LayoutTarget = target === '64bit' ? '32bit' : '64bit';
  const otherOpts: LayoutOptions = { target: otherTarget };
  const otherCatalog = buildStructCatalog(typeDict, otherOpts);

  const out: MessageComposition[] = [];

  for (const msg of messageInterfaces) {
    if (!msg.structResolved || !msg.struct) continue;

    const rootName = msg.struct.name;
    const here = layoutOf(catalog, rootName);
    const there = layoutOf(otherCatalog, rootName);
    if (!here) continue;

    const warnings = collectWarnings(rootName, structRoles);
    const sizeByTarget = {
      [target]: here.totalSizeBytes,
      [otherTarget]: there?.totalSizeBytes ?? here.totalSizeBytes,
    } as Record<LayoutTarget, number>;
    const paddingByTarget = {
      [target]: here.paddingBytes,
      [otherTarget]: there?.paddingBytes ?? here.paddingBytes,
    } as Record<LayoutTarget, number>;

    out.push({
      msgConstant: msg.msgTypeConstant,
      msgTypeValue: msg.msgTypeValue,
      rootStruct: rootName,
      sourceFile: msg.struct.sourceFile,
      sizeByTarget,
      paddingByTarget,
      differsAcrossTargets: sizeByTarget['32bit'] !== sizeByTarget['64bit'],
      isEstimated: here.isEstimated,
      ...(here.packAttribute !== undefined && { packAttribute: here.packAttribute }),
      parts: partsOf(rootName, catalog, structRoles, 0, maxDepth, new Set([rootName]), 0),
      pointerWarnings: warnings.pointers,
      variableArrayWarnings: warnings.variableArrays,
    });
  }

  out.sort((a, b) => a.msgConstant.localeCompare(b.msgConstant));
  return out;
}

/**
 * One-line summary: `CicHeader + pad(4) + FusedContact + sockaddr_in`.
 *
 * Compact enough to sit in the LLM context digest, so the model knows every
 * message's composition without spending a tool call.
 */
export function summarizeComposition(c: MessageComposition): string {
  return c.parts
    .map((p) => {
      if (p.kind === 'padding') return `pad(${p.sizeBytes})`;
      if (p.kind === 'block') {
        return p.arrayLength !== undefined
          ? `${p.typeName}[${p.arrayLength}]`
          : `${p.typeName}`;
      }
      return p.name ?? '?';
    })
    .join(' + ');
}
