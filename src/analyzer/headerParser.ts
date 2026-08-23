import type Parser from 'web-tree-sitter';
import type { AnalysisWarning, CDefine, CEnum, CField, CStruct, LoadedFile, TypeDict } from './types';
import { extractConditionalBlocks } from './preprocessor';
import { buildPackMap, resolvePack } from './packDetection';

export interface HeaderParseResult {
  typeDict: TypeDict;
  warnings: AnalysisWarning[];
}

// ─── Tree-sitter query strings ────────────────────────────────────────────────

const STRUCT_QUERY = `
(struct_specifier
  name: (type_identifier) @name
  body: (field_declaration_list) @body)

(type_definition
  type: (struct_specifier
    name: (type_identifier)? @name
    body: (field_declaration_list) @body)
  declarator: (type_identifier) @typedef_name)
`;

const ENUM_QUERY = `
(enum_specifier
  name: (type_identifier) @name
  body: (enumerator_list) @body)

(type_definition
  type: (enum_specifier
    name: (type_identifier)? @name
    body: (enumerator_list) @body)
  declarator: (type_identifier) @typedef_name)
`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Declaration text with the field list removed, so a packed *member* cannot
 *  mark the parent packed. `__attribute__((packed))` is still visible before
 *  the struct keyword, after the brace, or after the declarator. */
function declarationText(bodyNode: Parser.SyntaxNode): string {
  let cur: Parser.SyntaxNode | null = bodyNode.parent;
  let best: Parser.SyntaxNode | null = null;
  for (let hops = 0; cur && hops < 4; hops++) {
    if (cur.type === 'struct_specifier') best = cur;
    if (cur.type === 'type_definition' || cur.type === 'declaration' || cur.type === 'field_declaration') {
      return stripBody(cur.text, bodyNode.text);
    }
    cur = cur.parent;
  }
  return stripBody(best?.text ?? bodyNode.text, bodyNode.text);
}

function stripBody(decl: string, body: string): string {
  const i = decl.indexOf(body);
  return i === -1 ? decl : decl.slice(0, i) + decl.slice(i + body.length);
}

function nodeText(node: Parser.SyntaxNode): string {
  return node.text.trim();
}

function hasPointerDeclarator(node: Parser.SyntaxNode): boolean {
  if (node.type === 'pointer_declarator') return true;
  return node.children.some(hasPointerDeclarator);
}

/** Keep `*` on the type. The layout engine only treats a field as a pointer if
 *  the type contains `*` or the name starts with `*`; stripping stars from the
 *  name and leaving `int` / `char` lays the member out as a value. */
function fieldFromDeclarator(typeStr: string, decl: Parser.SyntaxNode): CField {
  const raw = nodeText(decl);
  const pointer = hasPointerDeclarator(decl) || raw.includes('*');
  const name = raw.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
  return { type: pointer && !typeStr.includes('*') ? `${typeStr} *` : typeStr, name };
}

function extractFields(bodyNode: Parser.SyntaxNode): CField[] {
  const fields: CField[] = [];
  for (const child of bodyNode.children) {
    if (child.type === 'field_declaration') {
      const typeNode = child.childForFieldName('type') ?? child.children[0];
      // `array_declarator` must be included or every array member is silently
      // dropped — `char sin_zero[8]`, `char label[32]` — and every byte offset
      // after it is wrong. The `[N]` is kept on the name so the layout engine
      // sees the extent.
      const declarators = child.children.filter(
        (c) =>
          c.type === 'field_identifier' ||
          c.type === 'pointer_declarator' ||
          c.type === 'array_declarator'
      );
      const typeStr = typeNode ? nodeText(typeNode) : 'unknown';
      if (declarators.length > 0) {
        for (const decl of declarators) {
          fields.push(fieldFromDeclarator(typeStr, decl));
        }
      } else {
        // Fallback: last non-type child
        const last = child.children[child.children.length - 1];
        if (last && last.type !== ';') {
          fields.push({ type: typeStr, name: nodeText(last) });
        }
      }
    }
  }
  return fields;
}

function extractEnumValues(bodyNode: Parser.SyntaxNode): string[] {
  return bodyNode.children
    .filter((c) => c.type === 'enumerator')
    .map((c) => {
      const nameNode = c.childForFieldName('name') ?? c.children[0];
      return nameNode ? nodeText(nameNode) : '';
    })
    .filter(Boolean);
}

function defineCategory(name: string, value: string): CDefine['category'] {
  if (/port|addr|ip|host/i.test(name) || /^0x[\dA-Fa-f]+$/.test(value)) return 'network';
  if (/size|len|max|min|buf|count/i.test(name)) return 'sizing';
  if (/flag|mask|bit|mode/i.test(name)) return 'flags';
  if (/type|id|op|cmd|msg|pkt/i.test(name)) return 'protocol';
  return 'other';
}

function structsEqual(a: CStruct, b: CStruct): boolean {
  if (a.fields.length !== b.fields.length) return false;
  return a.fields.every((f, i) => f.name === b.fields[i].name && f.type === b.fields[i].type);
}

function enumsEqual(a: CEnum, b: CEnum): boolean {
  if (a.values.length !== b.values.length) return false;
  return a.values.every((v, i) => v === b.values[i]);
}

// ─── Main parser ─────────────────────────────────────────────────────────────

function parseDefines(content: string, sourceFile: string, conditional: boolean): CDefine[] {
  const defines: CDefine[] = [];
  const re = /^[ \t]*#\s*define\s+(\w+)\s+(.+?)(?:\s*\/\/.*)?$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const name = m[1];
    const value = m[2].trim();
    defines.push({
      name,
      value,
      category: defineCategory(name, value),
      sourceFile,
      conditional,
    });
  }
  return defines;
}

export async function parseHeader(
  file: LoadedFile,
  parser: Parser,
  visiting: Set<string> = new Set()
): Promise<HeaderParseResult> {
  const result: HeaderParseResult = {
    typeDict: { structs: [], enums: [], defines: [] },
    warnings: [],
  };

  if (visiting.has(file.filename)) {
    result.warnings.push({
      kind: 'circular-include',
      message: `Circular include detected involving ${file.filename}`,
      files: [file.filename],
    });
    return result;
  }

  visiting.add(file.filename);

  // Extract preprocessor blocks so we can tag conditional symbols
  const preResult = extractConditionalBlocks(file.content);

  // Parse the full file with tree-sitter (all branches inlined by preprocessor)
  const tree = parser.parse(file.content);

  // `#pragma pack` is lexically scoped, so resolve it per declaration line.
  const packAt = buildPackMap(file.content);

  // ── Structs ──────────────────────────────────────────────────────────────
  try {
    const structQuery = parser.getLanguage().query(STRUCT_QUERY);
    const structMatches = structQuery.matches(tree.rootNode);

    for (const match of structMatches) {
      const nameCapture = match.captures.find(
        (c) => c.name === 'typedef_name' || c.name === 'name'
      );
      const bodyCapture = match.captures.find((c) => c.name === 'body');
      if (!nameCapture || !bodyCapture) continue;

      const name = nodeText(nameCapture.node);
      const fields = extractFields(bodyCapture.node);
      const pack = resolvePack(
        declarationText(bodyCapture.node),
        packAt(bodyCapture.node.startPosition.row),
      );
      const isConditional =
        preResult.hasConditionals &&
        preResult.blocks.some(
          (b) =>
            nameCapture.node.startPosition.row >= b.startLine &&
            nameCapture.node.startPosition.row <= b.endLine
        );

      const existing = result.typeDict.structs.find((s) => s.name === name);
      if (existing) {
        if (!structsEqual(existing, { name, fields, sourceFile: file.filename, conditional: isConditional })) {
          // Conflict — keep both as variants
          existing.variants = existing.variants ?? [{ ...existing }];
          existing.variants.push({ name, fields, sourceFile: file.filename, conditional: isConditional });
          existing.conflictsWith = existing.conflictsWith ?? [];
          if (!existing.conflictsWith.includes(file.filename)) {
            existing.conflictsWith.push(file.filename);
          }
          result.warnings.push({
            kind: 'conflict',
            message: `struct ${name} defined differently in ${existing.sourceFile} and ${file.filename}`,
            files: [existing.sourceFile, file.filename],
          });
        }
        // Identical — silent dedup
      } else {
        result.typeDict.structs.push({
          name,
          fields,
          sourceFile: file.filename,
          conditional: isConditional,
          ...pack,
        });
      }
    }
  } catch {
    // Query may fail on malformed source — continue
  }

  // ── Enums ────────────────────────────────────────────────────────────────
  try {
    const enumQuery = parser.getLanguage().query(ENUM_QUERY);
    const enumMatches = enumQuery.matches(tree.rootNode);

    for (const match of enumMatches) {
      const nameCapture = match.captures.find(
        (c) => c.name === 'typedef_name' || c.name === 'name'
      );
      const bodyCapture = match.captures.find((c) => c.name === 'body');
      if (!nameCapture || !bodyCapture) continue;

      const name = nodeText(nameCapture.node);
      const values = extractEnumValues(bodyCapture.node);
      const isConditional =
        preResult.hasConditionals &&
        preResult.blocks.some(
          (b) =>
            nameCapture.node.startPosition.row >= b.startLine &&
            nameCapture.node.startPosition.row <= b.endLine
        );

      const existing = result.typeDict.enums.find((e) => e.name === name);
      if (existing) {
        if (!enumsEqual(existing, { name, values, sourceFile: file.filename, conditional: isConditional })) {
          existing.variants = existing.variants ?? [{ ...existing }];
          existing.variants.push({ name, values, sourceFile: file.filename, conditional: isConditional });
          existing.conflictsWith = existing.conflictsWith ?? [];
          if (!existing.conflictsWith.includes(file.filename)) {
            existing.conflictsWith.push(file.filename);
          }
          result.warnings.push({
            kind: 'conflict',
            message: `enum ${name} defined differently in ${existing.sourceFile} and ${file.filename}`,
            files: [existing.sourceFile, file.filename],
          });
        }
      } else {
        result.typeDict.enums.push({
          name,
          values,
          sourceFile: file.filename,
          conditional: isConditional,
        });
      }
    }
  } catch {
    // Query may fail on malformed source — continue
  }

  // ── Defines ──────────────────────────────────────────────────────────────
  // Parse defines from the raw content (tree-sitter doesn't handle preprocessor directives in detail)
  const topLevelDefines = parseDefines(file.content, file.filename, false);
  // Also parse defines from conditional branches, tagging them conditional
  if (preResult.hasConditionals) {
    for (const block of preResult.blocks) {
      for (const branchText of block.branchTexts) {
        const branchDefines = parseDefines(branchText, file.filename, true);
        topLevelDefines.push(...branchDefines);
      }
    }
  }
  // Dedup defines by name (first wins)
  for (const def of topLevelDefines) {
    if (!result.typeDict.defines.some((d) => d.name === def.name)) {
      result.typeDict.defines.push(def);
    }
  }

  // ── Typedef aliases ──────────────────────────────────────────────────────
  // Capture plain `typedef ExistingType NewName;` (not struct/enum typedefs — those are handled above).
  // The base type may be several words: `typedef unsigned short __sa_family_t;`.
  // Matching only single-word bases leaves system aliases unresolved, and the
  // layout engine then substitutes pointer size for them — silently wrong offsets.
  {
    const aliasRe = /\btypedef\s+([A-Za-z_][\w\s]*?)\s+(\w+)\s*;/g;
    let m: RegExpExecArray | null;
    while ((m = aliasRe.exec(file.content)) !== null) {
      // `typedef struct timeval timeval;` aliases to the tag name, not `struct timeval`.
      const existing = m[1].replace(/^(struct|union|enum)\s+/, '').trim();
      const alias = m[2];
      if (!existing || existing === alias) continue;
      // Skip if the alias is itself a struct/enum name already captured
      const isStructOrEnum =
        result.typeDict.structs.some((s) => s.name === alias) ||
        result.typeDict.enums.some((e) => e.name === alias);
      if (!isStructOrEnum) {
        if (!result.typeDict.typedefAliases) result.typeDict.typedefAliases = {};
        result.typeDict.typedefAliases[alias] = existing;
      }
    }
  }

  // ── Encoding warning ─────────────────────────────────────────────────────
  if (file.encoding === 'latin-1') {
    result.warnings.push({
      kind: 'encoding',
      message: `${file.filename} decoded as Latin-1 — verify special characters`,
      files: [file.filename],
    });
  }

  visiting.delete(file.filename);
  return result;
}

export async function parseHeaders(
  files: LoadedFile[],
  parser: Parser
): Promise<HeaderParseResult> {
  const combined: HeaderParseResult = {
    typeDict: { structs: [], enums: [], defines: [] },
    warnings: [],
  };
  const visiting = new Set<string>();

  for (const file of files) {
    const r = await parseHeader(file, parser, visiting);

    // Merge structs (dedup / conflict detection across files)
    for (const s of r.typeDict.structs) {
      const existing = combined.typeDict.structs.find((e) => e.name === s.name);
      if (!existing) {
        combined.typeDict.structs.push(s);
      } else if (!structsEqual(existing, s)) {
        existing.variants = existing.variants ?? [{ ...existing }];
        existing.variants.push(s);
        existing.conflictsWith = existing.conflictsWith ?? [];
        if (!existing.conflictsWith.includes(s.sourceFile)) {
          existing.conflictsWith.push(s.sourceFile);
          combined.warnings.push({
            kind: 'conflict',
            message: `struct ${s.name} defined differently in ${existing.sourceFile} and ${s.sourceFile}`,
            files: [existing.sourceFile, s.sourceFile],
          });
        }
      }
    }

    // Merge enums
    for (const e of r.typeDict.enums) {
      const existing = combined.typeDict.enums.find((x) => x.name === e.name);
      if (!existing) {
        combined.typeDict.enums.push(e);
      } else if (!enumsEqual(existing, e)) {
        existing.variants = existing.variants ?? [{ ...existing }];
        existing.variants.push(e);
        existing.conflictsWith = existing.conflictsWith ?? [];
        if (!existing.conflictsWith.includes(e.sourceFile)) {
          existing.conflictsWith.push(e.sourceFile);
          combined.warnings.push({
            kind: 'conflict',
            message: `enum ${e.name} defined differently in ${existing.sourceFile} and ${e.sourceFile}`,
            files: [existing.sourceFile, e.sourceFile],
          });
        }
      }
    }

    // Merge defines (first wins)
    for (const d of r.typeDict.defines) {
      if (!combined.typeDict.defines.some((x) => x.name === d.name)) {
        combined.typeDict.defines.push(d);
      }
    }

    // Merge typedef aliases (first wins)
    if (r.typeDict.typedefAliases) {
      if (!combined.typeDict.typedefAliases) combined.typeDict.typedefAliases = {};
      for (const [alias, canonical] of Object.entries(r.typeDict.typedefAliases)) {
        if (!(alias in combined.typeDict.typedefAliases)) {
          combined.typeDict.typedefAliases[alias] = canonical;
        }
      }
    }

    // Merge warnings (dedup by message)
    for (const w of r.warnings) {
      if (!combined.warnings.some((x) => x.message === w.message)) {
        combined.warnings.push(w);
      }
    }
  }

  return combined;
}
