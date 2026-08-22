/**
 * Struct role analysis — which structs are wire messages, and which are the
 * blocks composed into them.
 *
 * Messages in legacy C are frequently assembled from reusable pieces: a shared
 * header envelope, a kinematics block reused across several messages, a system
 * type from `<netinet/in.h>`. A flat struct list cannot distinguish the message
 * from its parts. This pass builds the containment graph and classifies each
 * struct by in-degree crossed with binding evidence.
 *
 * Two precedence rules, both of which are easy to get wrong:
 *
 *   1. An envelope beats a binding. A shared header sits textually adjacent to a
 *      message constant in nearly every file, because the idiom is
 *      `if (msg->hdr.msg_type == MSG_TYPE_X)`. It is still a block, embedded in
 *      every message, not a message itself.
 *   2. Binding evidence must be *strong* — a resolved `MessageInterface.struct`
 *      or a high/medium-confidence `PayloadResolution` at a real send site.
 *      Textual co-occurrence promotes every shared block that happens to live
 *      near a constant.
 */

import type { CStruct, MessageInterface, TypeDict } from './types';
import type { PayloadResolution } from './payloadResolver';
import type { StructCatalog } from './structLayoutEngine';

export type StructRole =
  | 'wire-root'          // a message; nothing embeds it
  | 'wire-root-nested'   // a message that is *also* embedded in a larger struct
  | 'envelope'           // a header prepended to many messages
  | 'root-candidate'     // nothing embeds it and it is used, but no binding found
  | 'shared-block'       // embedded by two or more parents
  | 'block'              // embedded by exactly one parent
  | 'orphan';            // nothing embeds it and nothing references it

/** How a struct is embedded in one parent. */
export interface ContainmentEdge {
  parent: string;
  /** True when it is the parent's first member — the envelope signal. */
  isFirstField: boolean;
  /** Array length when embedded as an array (a batch), else undefined. */
  arrayLength?: number;
  fieldName: string;
}

export interface StructRoleInfo {
  name: string;
  sourceFile: string;
  role: StructRole;
  /** Distinct structs embedding this one by value. */
  inDegree: number;
  containedBy: ContainmentEdge[];
  /** Struct types this one embeds by value. */
  contains: string[];
  /** Longest containment chain below this struct. */
  depth: number;
  fieldCount: number;
  /** Message constants bound to this struct by strong evidence. */
  boundConstants: string[];
  /** Pointer members — the struct is not flat-serializable. */
  pointerFields: string[];
  /** Array members with a non-literal length — `sizeof` misreports these. */
  variableArrayFields: string[];
}

export interface StructRoleReport {
  roles: StructRoleInfo[];
  byName: Map<string, StructRoleInfo>;
  /** Structs classified as `wire-root` or `wire-root-nested`, in report order. */
  wireRoots: string[];
  /** Structs classified as `envelope`. */
  envelopes: string[];
}

export interface StructRoleInput {
  typeDict: TypeDict;
  messageInterfaces: MessageInterface[];
  payloadResolutions: PayloadResolution[];
  structCatalog?: StructCatalog;
  /** Struct names referenced anywhere in loaded source, for orphan detection. */
  referencedInSource: Set<string>;
}

/** In-degree at which a first-position member is treated as an envelope. */
const ENVELOPE_MIN_PARENTS = 3;
/** Fraction of parents that must place it first. */
const ENVELOPE_FIRST_RATIO = 0.8;

const ROLE_ORDER: Record<StructRole, number> = {
  'wire-root-nested': 0,
  'wire-root': 1,
  'envelope': 2,
  'root-candidate': 3,
  'shared-block': 4,
  'block': 5,
  'orphan': 6,
};

/**
 * Resolve a field's type name to a struct in the dictionary, following typedef
 * aliases. Mirrors `canonicalName` in headerGenBundle — kept local so the two
 * passes can evolve independently.
 */
function resolveFieldStruct(rawType: string, typeDict: TypeDict): CStruct | null {
  let name = rawType
    .replace(/\b(const|volatile|restrict|struct|union|enum|signed|unsigned)\b/g, '')
    .replace(/\*/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = name.split(' ').filter(Boolean);
  name = tokens[tokens.length - 1] ?? '';
  if (!name) return null;

  for (let hops = 0; hops < 4; hops++) {
    const direct = typeDict.structs.find((s) => s.name === name);
    if (direct) return direct;
    const alias = typeDict.typedefAliases?.[name];
    if (!alias || alias === name) break;
    name = alias;
  }
  return typeDict.structs.find((s) => s.name === name) ?? null;
}

/** A pointer member does not compose the parent — it references it. */
function isPointerField(type: string, fieldName: string): boolean {
  return type.includes('*') || fieldName.startsWith('*');
}

/** `char note[64]` is fixed; `char note[]` or `[MAX]` is not resolvable here. */
function arrayLengthOf(type: string, fieldName: string): number | undefined {
  const m = `${fieldName}${type}`.match(/\[(\d+)\]/);
  return m ? parseInt(m[1], 10) : undefined;
}

function hasVariableArray(type: string, fieldName: string): boolean {
  const combined = `${fieldName}${type}`;
  return /\[[^\]]*\]/.test(combined) && !/\[\d+\]/.test(combined);
}

export function analyzeStructRoles(input: StructRoleInput): StructRoleReport {
  const { typeDict, messageInterfaces, payloadResolutions, referencedInSource } = input;

  // ── Containment graph ──────────────────────────────────────────────────────
  const contains = new Map<string, Set<string>>();
  const containedBy = new Map<string, ContainmentEdge[]>();
  const pointerFields = new Map<string, string[]>();
  const variableArrays = new Map<string, string[]>();

  for (const s of typeDict.structs) {
    contains.set(s.name, new Set());
    pointerFields.set(s.name, []);
    variableArrays.set(s.name, []);
  }

  for (const s of typeDict.structs) {
    s.fields.forEach((f, index) => {
      if (hasVariableArray(f.type, f.name)) {
        variableArrays.get(s.name)?.push(f.name);
      }
      if (isPointerField(f.type, f.name)) {
        pointerFields.get(s.name)?.push(f.name);
        return; // a pointer is a reference, not composition
      }
      const child = resolveFieldStruct(f.type, typeDict);
      if (!child || child.name === s.name) return;

      contains.get(s.name)?.add(child.name);
      const edges = containedBy.get(child.name) ?? [];
      // One parent counts once even if it embeds the child twice.
      if (!edges.some((e) => e.parent === s.name)) {
        edges.push({
          parent: s.name,
          isFirstField: index === 0,
          fieldName: f.name,
          ...(arrayLengthOf(f.type, f.name) !== undefined && {
            arrayLength: arrayLengthOf(f.type, f.name),
          }),
        });
      }
      containedBy.set(child.name, edges);
    });
  }

  // ── Strong binding evidence ────────────────────────────────────────────────
  // Only a resolved MessageInterface struct or a confident PayloadResolution.
  // Never textual proximity.
  const bound = new Map<string, Set<string>>();
  const addBinding = (structName: string, constant: string | null) => {
    if (!constant) return;
    const set = bound.get(structName) ?? new Set<string>();
    set.add(constant);
    bound.set(structName, set);
  };

  for (const msg of messageInterfaces) {
    if (msg.structResolved && msg.struct) {
      addBinding(msg.struct.name, msg.msgTypeConstant);
    }
  }
  for (const res of payloadResolutions) {
    if (res.confidence !== 'high' && res.confidence !== 'medium') continue;
    const name = res.resolvedStruct?.name ?? res.resolvedStructName;
    if (name) addBinding(name, res.msgIdConstant ?? '(payload)');
  }

  // ── Depth ──────────────────────────────────────────────────────────────────
  const depthMemo = new Map<string, number>();
  function depthOf(name: string, seen: Set<string> = new Set()): number {
    if (seen.has(name)) return 0; // cycle guard
    const memo = depthMemo.get(name);
    if (memo !== undefined && seen.size === 0) return memo;
    const children = contains.get(name);
    let best = 0;
    if (children) {
      for (const c of children) {
        best = Math.max(best, 1 + depthOf(c, new Set([...seen, name])));
      }
    }
    if (seen.size === 0) depthMemo.set(name, best);
    return best;
  }

  // ── Classification ─────────────────────────────────────────────────────────
  const roles: StructRoleInfo[] = [];

  for (const s of typeDict.structs) {
    const edges = containedBy.get(s.name) ?? [];
    const inDegree = edges.length;
    const constants = [...(bound.get(s.name) ?? [])].sort();
    const firstCount = edges.filter((e) => e.isFirstField).length;

    // Rule 1: envelope wins. A header embedded first in many messages is a
    // block, whatever constants it sits near.
    const isEnvelope =
      inDegree >= ENVELOPE_MIN_PARENTS && firstCount / inDegree >= ENVELOPE_FIRST_RATIO;

    let role: StructRole;
    if (isEnvelope) {
      role = 'envelope';
    } else if (constants.length > 0) {
      // Rule 2: strong binding makes it a message even when embedded — a message
      // batched into an aggregate is still a message.
      role = inDegree > 0 ? 'wire-root-nested' : 'wire-root';
    } else if (inDegree >= 2) {
      role = 'shared-block';
    } else if (inDegree === 1) {
      role = 'block';
    } else if (referencedInSource.has(s.name)) {
      role = 'root-candidate';
    } else {
      role = 'orphan';
    }

    roles.push({
      name: s.name,
      sourceFile: s.sourceFile,
      role,
      inDegree,
      containedBy: [...edges].sort((a, b) => a.parent.localeCompare(b.parent)),
      contains: [...(contains.get(s.name) ?? [])].sort(),
      depth: depthOf(s.name),
      fieldCount: s.fields.length,
      boundConstants: constants,
      pointerFields: pointerFields.get(s.name) ?? [],
      variableArrayFields: variableArrays.get(s.name) ?? [],
    });
  }

  // Stable ordering: role priority, then deepest first, then name. Determinism
  // matters — this feeds a prompt digest that relies on prefix caching.
  roles.sort(
    (a, b) =>
      ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
      b.depth - a.depth ||
      a.name.localeCompare(b.name),
  );

  return {
    roles,
    byName: new Map(roles.map((r) => [r.name, r])),
    wireRoots: roles
      .filter((r) => r.role === 'wire-root' || r.role === 'wire-root-nested')
      .map((r) => r.name),
    envelopes: roles.filter((r) => r.role === 'envelope').map((r) => r.name),
  };
}
