import type Parser from 'web-tree-sitter';
import type { CStruct, TypeDict } from './types';

// ── Public types ───────────────────────────────────────────────────────────────

export type PayloadConfidence = 'high' | 'medium' | 'low' | 'unresolved';

export type PayloadStrategy =
  | 'address-of'
  | 'pointer'
  | 'cast'
  | 'memcpy'
  | 'msg-id-correlation'
  | 'callback'
  | 'unresolved';

export interface PayloadResolution {
  sendSiteFile: string;
  sendSiteLine: number;
  sendSiteText: string;
  patternName: string;
  resolvedStructName: string | null;
  resolvedStruct: CStruct | null;
  msgIdConstant: string | null;
  msgIdValue: string | null;
  confidence: PayloadConfidence;
  strategy: PayloadStrategy;
  notes: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function nodeText(node: Parser.SyntaxNode): string {
  return node.text.trim();
}

/** Walk ancestors up to function_definition or translation_unit. */
function enclosingFunction(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let cur: Parser.SyntaxNode | null = node.parent;
  while (cur && cur.type !== 'function_definition' && cur.type !== 'translation_unit') {
    cur = cur.parent;
  }
  return cur?.type === 'function_definition' ? cur : null;
}

/** Walk sibling statements *before* the given call node, including all enclosing scopes up to the function body. */
function priorSiblings(callNode: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const siblings: Parser.SyntaxNode[] = [];
  let current: Parser.SyntaxNode | null = callNode;

  while (current) {
    let compound: Parser.SyntaxNode | null = current.parent;
    while (compound && compound.type !== 'compound_statement' && compound.type !== 'function_definition') {
      compound = compound.parent;
    }
    if (!compound) break;

    for (const child of compound.children) {
      if (child.startIndex >= current.startIndex) break;
      siblings.push(child);
    }

    if (compound.type === 'function_definition') break;
    current = compound;
  }

  return siblings;
}

/** Resolve a type name to a CStruct via typeDict, stripping struct/const/pointer qualifiers.
 *  Chases plain typedef aliases (e.g. PASSBACK → DIST_PASSBACK) up to 4 hops. */
function resolveType(rawType: string, typeDict: TypeDict): CStruct | null {
  let name = rawType
    .replace(/\b(const|volatile|restrict|struct|union)\b/g, '')
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  for (let hops = 0; hops < 4; hops++) {
    const found = typeDict.structs.find((s) => s.name === name);
    if (found) return found;
    const canonical = typeDict.typedefAliases?.[name];
    if (!canonical || canonical === name) break;
    name = canonical;
  }
  return null;
}

/**
 * Extract the base struct type name from a declaration node, e.g.
 *   `NavMsg msg;`  → "NavMsg"
 *   `const NavMsg *p;` → "NavMsg"
 */
function declaredType(declNode: Parser.SyntaxNode): string | null {
  const typeNode = declNode.childForFieldName('type') ?? declNode.children[0];
  if (!typeNode) return null;
  const raw = nodeText(typeNode);
  const cleaned = raw
    .replace(/\b(const|volatile|restrict|struct|union)\b/g, '')
    .replace(/\*/g, '')
    .trim();
  return cleaned || null;
}

/**
 * Find a local variable declaration in `statements` whose declarator matches `varName`.
 * Returns the declared type string if found.
 */
function findLocalVarType(statements: Parser.SyntaxNode[], varName: string): string | null {
  for (const stmt of statements) {
    if (stmt.type !== 'declaration') continue;
    for (const child of stmt.children) {
      const declaratorText =
        child.type === 'identifier' ? nodeText(child) :
        child.type === 'pointer_declarator' ? nodeText(child).replace(/^\*+/, '') :
        child.type === 'init_declarator' ? (() => {
          const decl = child.childForFieldName('declarator');
          return decl ? nodeText(decl).replace(/^\*+/, '') : null;
        })() : null;
      if (declaratorText === varName) {
        return declaredType(stmt);
      }
    }
  }
  return null;
}

// ── Strategy implementations ──────────────────────────────────────────────────

/**
 * Strategy 1 — &variable (HIGH)
 * Arg node is a unary_expression with operator "&".
 */
function tryAddressOf(
  argNode: Parser.SyntaxNode,
  statements: Parser.SyntaxNode[],
  typeDict: TypeDict,
): { structName: string; struct: CStruct | null } | null {
  if (argNode.type !== 'unary_expression') return null;
  const op = argNode.childForFieldName('operator') ?? argNode.children[0];
  if (!op || op.text !== '&') return null;
  const operand = argNode.childForFieldName('argument') ?? argNode.children[argNode.children.length - 1];
  if (!operand) return null;
  // Get variable name (handle field access: &foo.bar → look up type of foo)
  const varName = operand.type === 'field_expression'
    ? nodeText(operand.childForFieldName('argument') ?? operand.children[0])
    : nodeText(operand);
  const typeName = findLocalVarType(statements, varName);
  if (!typeName) return null;
  return { structName: typeName, struct: resolveType(typeName, typeDict) };
}

/**
 * Strategy 2 — pointer param (HIGH)
 * Arg is a bare identifier; check if it's a pointer param of the enclosing function.
 */
function tryPointerParam(
  argNode: Parser.SyntaxNode,
  fnNode: Parser.SyntaxNode | null,
  typeDict: TypeDict,
): { structName: string; struct: CStruct | null } | null {
  if (argNode.type !== 'identifier') return null;
  if (!fnNode) return null;
  const argName = nodeText(argNode);
  const declarator = fnNode.childForFieldName('declarator');
  const params = declarator?.childForFieldName('parameters');
  if (!params) return null;
  for (const param of params.children) {
    if (param.type !== 'parameter_declaration') continue;
    const pdecl = param.childForFieldName('declarator');
    if (!pdecl) continue;
    // Check if the declarator is a pointer to argName
    const ptext = nodeText(pdecl);
    const paramName = ptext.replace(/^\*+/, '').trim();
    if (paramName !== argName) continue;
    // It's a pointer param if the declarator starts with * or the type has *
    const isPointer = ptext.startsWith('*') || nodeText(param).includes('*');
    if (!isPointer) continue;
    const typeNode = param.childForFieldName('type') ?? param.children[0];
    if (!typeNode) continue;
    const typeName = nodeText(typeNode)
      .replace(/\b(const|volatile|restrict|struct|union)\b/g, '')
      .replace(/\*/g, '')
      .trim();
    if (!typeName) continue;
    return { structName: typeName, struct: resolveType(typeName, typeDict) };
  }
  return null;
}

/**
 * Strategy 2b — local variable declaration (HIGH)
 * Arg is a bare identifier declared as a pointer in the enclosing function body.
 * Handles `TYPE *pb = &global;` or `TYPE *pb = (TYPE*) raw;` — the initialiser
 * is irrelevant; we only need the declared type.
 */
function tryLocalVarDecl(
  argNode: Parser.SyntaxNode,
  statements: Parser.SyntaxNode[],
  typeDict: TypeDict,
): { structName: string; struct: CStruct | null } | null {
  if (argNode.type !== 'identifier') return null;
  const varName = nodeText(argNode);
  const typeName = findLocalVarType(statements, varName);
  if (!typeName) return null;
  return { structName: typeName, struct: resolveType(typeName, typeDict) };
}

/** Primitive/opaque types that are not useful struct names. */
const PRIMITIVE_TYPES = new Set([
  'char', 'void', 'int', 'short', 'long', 'float', 'double',
  'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  'int8_t', 'int16_t', 'int32_t', 'int64_t',
  'size_t', 'ssize_t', 'ptrdiff_t', 'uintptr_t', 'intptr_t',
  'byte', 'word', 'dword', 'bool',
]);

/**
 * Strategy 3 — cast expression (MEDIUM)
 * Arg is a cast_expression. If the cast value is &var, try address-of on the
 * inner node first (HIGH confidence) — e.g. (MESSAGE_POINTER) &msg → NavMsg.
 * If the cast type resolves to a known struct, return it.
 * If the cast type is a primitive/opaque pointer (e.g. char*, void*), fall back
 * to resolving the inner identifier's declared type or param type (HIGH).
 */
function tryCast(
  argNode: Parser.SyntaxNode,
  statements: Parser.SyntaxNode[],
  typeDict: TypeDict,
  fnNode?: Parser.SyntaxNode | null,
): { structName: string; struct: CStruct | null; fromInner?: boolean } | null {
  if (argNode.type !== 'cast_expression') return null;
  const value = argNode.childForFieldName('value') ?? argNode.lastChild;
  // If the cast wraps &var, resolve the inner variable type (higher confidence)
  if (value) {
    const inner = tryAddressOf(value, statements, typeDict);
    if (inner) return { ...inner, fromInner: true };
  }
  const typeDesc = argNode.childForFieldName('type');
  if (!typeDesc) return null;
  const raw = nodeText(typeDesc)
    .replace(/\b(const|volatile|restrict|struct|union)\b/g, '')
    .replace(/\*/g, '')
    .trim();
  if (!raw) return null;

  const castStruct = resolveType(raw, typeDict);
  if (castStruct) return { structName: raw, struct: castStruct };

  // Cast type is primitive/opaque — try to resolve the inner value's actual type
  if (value && (PRIMITIVE_TYPES.has(raw) || !castStruct)) {
    // Inner is a bare identifier (e.g. (char*)output → look up output's declared type)
    if (value.type === 'identifier') {
      const localType = findLocalVarType(statements, nodeText(value));
      if (localType) {
        const s = resolveType(localType, typeDict);
        if (s) return { structName: localType, struct: s, fromInner: true };
      }
      if (fnNode) {
        const paramResult = tryPointerParam(value, fnNode, typeDict);
        if (paramResult?.struct) return { ...paramResult, fromInner: true };
      }
    }

    // Inner is a field access (e.g. (SLEMR_MESSAGE_POINTER) pb->somethingsend)
    // → resolve pb's type → look up field → get field's struct type
    if (value.type === 'field_expression') {
      const baseNode = value.childForFieldName('argument') ?? value.children[0];
      const fieldNode = value.childForFieldName('field') ?? value.children[value.children.length - 1];
      if (baseNode && fieldNode) {
        const baseName = nodeText(baseNode).replace(/^[*&]+/, '');
        const fieldName = nodeText(fieldNode);

        // Find base variable's declared type
        let baseTypeName = findLocalVarType(statements, baseName);
        if (!baseTypeName && fnNode) {
          const fakeNode = baseNode.type === 'identifier' ? baseNode : null;
          if (fakeNode) {
            const p = tryPointerParam(fakeNode, fnNode, typeDict);
            baseTypeName = p?.structName ?? null;
          }
        }

        if (baseTypeName) {
          const baseStruct = resolveType(baseTypeName, typeDict);
          if (baseStruct) {
            const field = baseStruct.fields.find((f) => f.name === fieldName);
            if (field) {
              const fieldBaseType = field.type
                .replace(/\b(const|volatile|restrict|struct|union)\b/g, '')
                .replace(/\*/g, '')
                .trim();
              const fieldStruct = resolveType(fieldBaseType, typeDict);
              if (fieldStruct) return { structName: fieldBaseType, struct: fieldStruct, fromInner: true };
            }
          }
        }
      }
    }
  }

  return { structName: raw, struct: castStruct };
}

/**
 * Strategy 3b — prior assignment tracing (HIGH/MEDIUM)
 * Arg is a bare identifier. Scan prior statements for `argName = <rhs>` and
 * apply address-of or cast resolution on the RHS.
 *   msgData = &ownship;          → address-of → HIGH
 *   msgData = (NavMsg *)buf;     → cast       → MEDIUM
 */
function tryAssignment(
  argNode: Parser.SyntaxNode,
  statements: Parser.SyntaxNode[],
  typeDict: TypeDict,
): { structName: string; struct: CStruct | null; confidence: PayloadConfidence; strategy: PayloadStrategy } | null {
  if (argNode.type !== 'identifier') return null;
  const varName = nodeText(argNode);

  // Walk statements in reverse so we pick up the most-recent assignment
  for (let i = statements.length - 1; i >= 0; i--) {
    const stmt = statements[i];
    // expression_statement → assignment_expression
    const expr = stmt.type === 'expression_statement' ? stmt.children[0] : null;
    if (!expr || expr.type !== 'assignment_expression') continue;

    const lhs = expr.childForFieldName('left') ?? expr.children[0];
    const rhs = expr.childForFieldName('right') ?? expr.children[expr.children.length - 1];
    if (!lhs || !rhs) continue;
    if (nodeText(lhs) !== varName) continue;

    // RHS is &var → address-of (HIGH)
    const addrOf = tryAddressOf(rhs, statements.slice(0, i), typeDict);
    if (addrOf) return { ...addrOf, confidence: 'high', strategy: 'address-of' };

    // RHS is (Type*)... → cast, possibly wrapping &var (MEDIUM or HIGH)
    const castResult = tryCast(rhs, statements.slice(0, i), typeDict);
    if (castResult) {
      return {
        ...castResult,
        confidence: castResult.fromInner ? 'high' : 'medium',
        strategy: castResult.fromInner ? 'address-of' : 'cast',
      };
    }
  }
  return null;
}

/**
 * Strategy 4 — memcpy(buffer, &source, ...) before send call (MEDIUM)
 * Looks for a prior `memcpy(argName, &src, ...)` and resolves the source type.
 */
function tryMemcpy(
  argNode: Parser.SyntaxNode,
  statements: Parser.SyntaxNode[],
  typeDict: TypeDict,
): { structName: string; struct: CStruct | null } | null {
  if (argNode.type !== 'identifier') return null;
  const bufName = nodeText(argNode);

  for (const stmt of statements) {
    // Look for expression_statement containing a call_expression to memcpy
    const exprStmt = stmt.type === 'expression_statement' ? stmt.children[0] : null;
    if (!exprStmt || exprStmt.type !== 'call_expression') continue;
    const callee = exprStmt.childForFieldName('function') ?? exprStmt.children[0];
    if (!callee || nodeText(callee) !== 'memcpy') continue;

    const args = exprStmt.childForFieldName('arguments') ?? exprStmt.children.find((c) => c.type === 'argument_list');
    if (!args) continue;
    const argList = args.children.filter((c) => c.type !== ',' && c.type !== '(' && c.type !== ')');
    if (argList.length < 2) continue;

    // First arg of memcpy should be our buffer
    const memcpyDst = argList[0];
    const dstText = nodeText(memcpyDst).replace(/^&/, '');
    if (dstText !== bufName) continue;

    // Second arg of memcpy — apply strategy 1 (address-of)
    const memcpySrc = argList[1];
    const srcResult = tryAddressOf(memcpySrc, statements, typeDict);
    if (srcResult) return srcResult;

    // Also try if it's a bare identifier — find its type
    if (memcpySrc.type === 'identifier') {
      const typeName = findLocalVarType(statements, nodeText(memcpySrc));
      if (typeName) return { structName: typeName, struct: resolveType(typeName, typeDict) };
    }
  }
  return null;
}

/**
 * Strategy 5 — msg-ID correlation (LOW)
 * Use impliedStructs or candidateTypes already extracted by Strategy B in sourceAnalyzer.
 */
function tryMsgIdCorrelation(
  impliedStructs: string[],
  typeDict: TypeDict,
): { structName: string; struct: CStruct | null } | null {
  for (const name of impliedStructs) {
    const s = typeDict.structs.find((st) => st.name === name);
    if (s) return { structName: name, struct: s };
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface PayloadResolverInput {
  /** The call_expression node for the IPC call. */
  callNode: Parser.SyntaxNode;
  /** Pattern name (for attribution). */
  patternName: string;
  /** 0-based index of the payload argument. */
  payloadArgIndex: number;
  /** The source file name (for annotation). */
  filename: string;
  /** Structs already implied by Strategy B in sourceAnalyzer (msg-ID correlation fallback). */
  impliedStructs: string[];
  typeDict: TypeDict;
}

export function resolvePayload(input: PayloadResolverInput): PayloadResolution {
  const { callNode, patternName, payloadArgIndex, filename, impliedStructs, typeDict } = input;

  const lineNum = callNode.startPosition.row + 1;
  const callText = nodeText(callNode).substring(0, 200);

  const argsNode = callNode.childForFieldName('arguments') ??
    callNode.children.find((c) => c.type === 'argument_list') ?? null;

  const base: Omit<PayloadResolution, 'resolvedStructName' | 'resolvedStruct' | 'confidence' | 'strategy' | 'notes'> = {
    sendSiteFile: filename,
    sendSiteLine: lineNum,
    sendSiteText: callText,
    patternName,
    msgIdConstant: null,
    msgIdValue: null,
  };

  if (!argsNode) {
    return { ...base, resolvedStructName: null, resolvedStruct: null, confidence: 'unresolved', strategy: 'unresolved', notes: 'No argument list found' };
  }

  const argNodes = argsNode.children.filter((c) => c.type !== ',' && c.type !== '(' && c.type !== ')');
  const payloadArg = argNodes[payloadArgIndex];

  if (!payloadArg) {
    return { ...base, resolvedStructName: null, resolvedStruct: null, confidence: 'unresolved', strategy: 'unresolved', notes: `Payload argument at index ${payloadArgIndex} not found (call has ${argNodes.length} args)` };
  }

  const fnNode = enclosingFunction(callNode);
  const stmts = priorSiblings(callNode);

  // Strategy 1: &variable
  const s1 = tryAddressOf(payloadArg, stmts, typeDict);
  if (s1) {
    return { ...base, resolvedStructName: s1.structName, resolvedStruct: s1.struct, confidence: 'high', strategy: 'address-of', notes: '' };
  }

  // Strategy 2: pointer param (function parameter)
  const s2 = tryPointerParam(payloadArg, fnNode, typeDict);
  if (s2?.struct) {
    return { ...base, resolvedStructName: s2.structName, resolvedStruct: s2.struct, confidence: 'high', strategy: 'pointer', notes: '' };
  }

  // Strategy 2b: local variable declaration (e.g. TYPE *pb = &global_data_passback)
  const s2b = tryLocalVarDecl(payloadArg, stmts, typeDict);
  if (s2b?.struct) {
    return { ...base, resolvedStructName: s2b.structName, resolvedStruct: s2b.struct, confidence: 'high', strategy: 'pointer', notes: '' };
  }

  // Strategy 3: cast (may recurse into &var, inner identifier, or field access)
  const s3 = tryCast(payloadArg, stmts, typeDict, fnNode);
  if (s3) {
    if (s3.struct) {
      const confidence = s3.fromInner ? 'high' : 'medium';
      const strategy = s3.fromInner ? 'pointer' : 'cast';
      return { ...base, resolvedStructName: s3.structName, resolvedStruct: s3.struct, confidence, strategy, notes: '' };
    }
    if (!PRIMITIVE_TYPES.has(s3.structName)) {
      // Cast type is a named typedef not in the struct catalog — show it at low confidence
      // rather than falling through to unresolved (e.g. SLEMR_MESSAGE_POINTER)
      return { ...base, resolvedStructName: s3.structName, resolvedStruct: null, confidence: 'low', strategy: 'cast', notes: 'Cast type not found in struct catalog' };
    }
    // Cast type is a primitive (char*, void*, etc.) — fall through to try other strategies
  }

  // Strategy 3b: prior assignment — msgData = &ownship / msgData = (NavMsg*)buf
  const s3b = tryAssignment(payloadArg, stmts, typeDict);
  if (s3b) {
    return { ...base, resolvedStructName: s3b.structName, resolvedStruct: s3b.struct, confidence: s3b.confidence, strategy: s3b.strategy, notes: 'Resolved via prior assignment' };
  }

  // Strategy 4: memcpy
  const s4 = tryMemcpy(payloadArg, stmts, typeDict);
  if (s4) {
    return { ...base, resolvedStructName: s4.structName, resolvedStruct: s4.struct, confidence: 'medium', strategy: 'memcpy', notes: '' };
  }

  // Strategy 5: msg-ID correlation
  const s5 = tryMsgIdCorrelation(impliedStructs, typeDict);
  if (s5) {
    return { ...base, resolvedStructName: s5.structName, resolvedStruct: s5.struct, confidence: 'low', strategy: 'msg-id-correlation', notes: 'Inferred from IPC wrapper parameter types' };
  }

  return { ...base, resolvedStructName: null, resolvedStruct: null, confidence: 'unresolved', strategy: 'unresolved', notes: 'No payload type resolution strategy succeeded' };
}
