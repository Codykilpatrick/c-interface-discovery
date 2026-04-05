import type Parser from 'web-tree-sitter';
import type { AnalysisWarning, CDefine, CEnum, CField, CStruct, LoadedFile, TypeDict } from './types';
import { extractConditionalBlocks } from './preprocessor';

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

function nodeText(node: Parser.SyntaxNode): string {
  return node.text.trim();
}

function extractFields(bodyNode: Parser.SyntaxNode): CField[] {
  const fields: CField[] = [];
  for (const child of bodyNode.children) {
    if (child.type === 'field_declaration') {
      const typeNode = child.childForFieldName('type') ?? child.children[0];
      const declarators = child.children.filter(
        (c) => c.type === 'field_identifier' || c.type === 'pointer_declarator'
      );
      const typeStr = typeNode ? nodeText(typeNode) : 'unknown';
      if (declarators.length > 0) {
        for (const decl of declarators) {
          fields.push({ type: typeStr, name: nodeText(decl).replace(/^\*+/, '') });
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

    // Merge warnings (dedup by message)
    for (const w of r.warnings) {
      if (!combined.warnings.some((x) => x.message === w.message)) {
        combined.warnings.push(w);
      }
    }
  }

  return combined;
}
