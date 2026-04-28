import { describe, it, expect } from 'vitest';
import { resolvePayload } from '../payloadResolver';
import type { PayloadResolverInput } from '../payloadResolver';
import type { TypeDict, CStruct } from '../types';

// ── Mock SyntaxNode builder ───────────────────────────────────────────────────
// We build minimal tree-like objects that match the shapes the resolver inspects.
// The resolver uses: .type, .text, .children, .parent, .startIndex,
//   .startPosition.row, childForFieldName(), .lastChild

type MockNode = {
  type: string;
  text: string;
  children: MockNode[];
  parent: MockNode | null;
  startIndex: number;
  startPosition: { row: number; column: number };
  childForFieldName(name: string): MockNode | null;
  lastChild: MockNode | null;
};

function mockNode(
  type: string,
  text: string,
  children: MockNode[] = [],
  fieldMap: Record<string, MockNode> = {},
  startIndex = 0,
  row = 0,
): MockNode {
  const node: MockNode = {
    type,
    text,
    children,
    parent: null,
    startIndex,
    startPosition: { row, column: 0 },
    childForFieldName: (name: string) => fieldMap[name] ?? null,
    get lastChild() { return children[children.length - 1] ?? null; },
  };
  for (const c of children) c.parent = node;
  return node;
}

// Helpers for argument list nodes
function argList(args: MockNode[]): MockNode {
  const commas = args.flatMap((a, i) => (i < args.length - 1 ? [a, mockNode(',', ',')] : [a]));
  const children = [mockNode('(', '('), ...commas, mockNode(')', ')')];
  return mockNode('argument_list', `(${args.map((a) => a.text).join(', ')})`, children);
}

function ident(name: string): MockNode {
  return mockNode('identifier', name);
}

function addressOf(operand: MockNode): MockNode {
  const op = mockNode('&', '&');
  const node = mockNode('unary_expression', `&${operand.text}`, [op, operand], {
    operator: op,
    argument: operand,
  });
  return node;
}

function castExpr(typeText: string, value: MockNode): MockNode {
  const typeNode = mockNode('type_descriptor', typeText);
  return mockNode('cast_expression', `(${typeText})${value.text}`, [typeNode, value], {
    type: typeNode,
    value,
  });
}

function declNode(typeText: string, varName: string): MockNode {
  const typeN = mockNode('type_specifier', typeText);
  const nameN = mockNode('identifier', varName);
  return mockNode('declaration', `${typeText} ${varName};`, [typeN, nameN], { type: typeN }, 0, 0);
}

function paramDecl(typeText: string, declText: string): MockNode {
  const typeN = mockNode('type_specifier', typeText);
  const declN = mockNode('pointer_declarator', declText);
  return mockNode('parameter_declaration', `${typeText} ${declText}`, [typeN, declN], {
    type: typeN,
    declarator: declN,
  });
}

// Build a minimal call_expression node for ipc_send
function buildCallNode(args: MockNode[], row = 10): MockNode {
  const callee = mockNode('identifier', 'ipc_send');
  const argsNode = argList(args);
  const call = mockNode(
    'call_expression',
    `ipc_send(${args.map((a) => a.text).join(', ')})`,
    [callee, argsNode],
    { function: callee, arguments: argsNode },
    100,
    row,
  );
  return call;
}

// Build an enclosing function_definition with given params
function buildFnDef(paramNodes: MockNode[], body: MockNode[], callNode: MockNode): MockNode {
  const paramList = mockNode('parameter_list', '', paramNodes);
  const fnDecl = mockNode('function_declarator', 'fn()', [mockNode('identifier', 'fn'), paramList], {
    parameters: paramList,
  });
  const retType = mockNode('primitive_type', 'void');
  const compound = mockNode(
    'compound_statement',
    '{}',
    [...body, mockNode('expression_statement', '', [callNode])],
    {},
    0,
    0,
  );
  const fn = mockNode('function_definition', 'void fn() {}', [retType, fnDecl, compound], {
    declarator: fnDecl,
    body: compound,
  });
  for (const c of fn.children) c.parent = fn;
  compound.parent = fn;
  callNode.parent = compound;
  return fn;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStruct(name: string): CStruct {
  return { name, fields: [{ type: 'float', name: 'x' }], sourceFile: 'types.h', conditional: false };
}

function makeTypeDict(structs: CStruct[]): TypeDict {
  return { structs, enums: [], defines: [] };
}

function makeInput(
  callNode: MockNode,
  payloadArgIndex: number,
  typeDict: TypeDict,
  impliedStructs: string[] = [],
): PayloadResolverInput {
  return {
    callNode: callNode as unknown as import('web-tree-sitter').SyntaxNode,
    patternName: 'ipc_send',
    payloadArgIndex,
    filename: 'sender.c',
    impliedStructs,
    typeDict,
  };
}

function assignStmt(lhsName: string, rhs: MockNode): MockNode {
  const lhs = ident(lhsName);
  const assign = mockNode('assignment_expression', `${lhsName} = ${rhs.text}`, [lhs, rhs], {
    left: lhs,
    right: rhs,
  });
  return mockNode('expression_statement', `${lhsName} = ${rhs.text};`, [assign]);
}

// ── Tests: Strategy 1 — address-of ───────────────────────────────────────────

describe('payloadResolver — Strategy 1: address-of', () => {
  it('resolves &msg to NavMsg when NavMsg is declared before the call', () => {
    const navStruct = makeStruct('NavMsg');
    const td = makeTypeDict([navStruct]);

    const msgDecl = declNode('NavMsg', 'msg');
    const callNode = buildCallNode([ident('sock'), ident('MSG_NAV'), addressOf(ident('msg')), ident('len')]);
    buildFnDef([], [msgDecl], callNode);

    const result = resolvePayload(makeInput(callNode, 2, td));
    expect(result.strategy).toBe('address-of');
    expect(result.confidence).toBe('high');
    expect(result.resolvedStructName).toBe('NavMsg');
    expect(result.resolvedStruct).toBe(navStruct);
  });

  it('returns unresolved when &var is used but var type is not in typeDict', () => {
    const td = makeTypeDict([]);
    const msgDecl = declNode('UnknownType', 'msg');
    const callNode = buildCallNode([ident('sock'), ident('MSG_NAV'), addressOf(ident('msg')), ident('len')]);
    buildFnDef([], [msgDecl], callNode);

    const result = resolvePayload(makeInput(callNode, 2, td));
    expect(result.strategy).toBe('address-of');
    expect(result.confidence).toBe('high');
    expect(result.resolvedStructName).toBe('UnknownType');
    expect(result.resolvedStruct).toBeNull(); // type not in dict
  });
});

// ── Tests: Strategy 2 — pointer param ────────────────────────────────────────

describe('payloadResolver — Strategy 2: pointer param', () => {
  it('resolves AcousticMsg* parameter to AcousticMsg', () => {
    const acousticStruct = makeStruct('AcousticMsg');
    const td = makeTypeDict([acousticStruct]);

    const callNode = buildCallNode([ident('sock'), ident('MSG_ACOUSTIC'), ident('msg_ptr'), ident('len')]);
    const param = paramDecl('AcousticMsg', '*msg_ptr');
    buildFnDef([param], [], callNode);

    const result = resolvePayload(makeInput(callNode, 2, td));
    expect(result.strategy).toBe('pointer');
    expect(result.confidence).toBe('high');
    expect(result.resolvedStructName).toBe('AcousticMsg');
  });
});

// ── Tests: Strategy 3 — cast ──────────────────────────────────────────────────

describe('payloadResolver — Strategy 3: cast', () => {
  it('resolves (RadarMsg *)buf to RadarMsg', () => {
    const radarStruct = makeStruct('RadarMsg');
    const td = makeTypeDict([radarStruct]);

    const cast = castExpr('RadarMsg *', ident('raw_buf'));
    const callNode = buildCallNode([ident('sock'), ident('MSG_RADAR'), cast, ident('len')]);
    buildFnDef([], [], callNode);

    const result = resolvePayload(makeInput(callNode, 2, td));
    expect(result.strategy).toBe('cast');
    expect(result.confidence).toBe('medium');
    expect(result.resolvedStructName).toBe('RadarMsg');
  });

  it('resolves even when struct not in typeDict (name captured, struct null)', () => {
    const td = makeTypeDict([]);
    const cast = castExpr('SomeType *', ident('buf'));
    const callNode = buildCallNode([ident('sock'), ident('ID'), cast, ident('len')]);
    buildFnDef([], [], callNode);

    const result = resolvePayload(makeInput(callNode, 2, td));
    expect(result.strategy).toBe('cast');
    expect(result.resolvedStructName).toBe('SomeType');
    expect(result.resolvedStruct).toBeNull();
  });
});

// ── Tests: Strategy 5 — msg-ID correlation ────────────────────────────────────

describe('payloadResolver — Strategy 5: msg-id-correlation', () => {
  it('uses impliedStructs when no other strategy resolves', () => {
    const td = makeTypeDict([makeStruct('NavMsg')]);
    const callNode = buildCallNode([ident('sock'), ident('id'), ident('buf'), ident('len')]);
    buildFnDef([], [], callNode);

    const result = resolvePayload(makeInput(callNode, 2, td, ['NavMsg']));
    expect(result.strategy).toBe('msg-id-correlation');
    expect(result.confidence).toBe('low');
    expect(result.resolvedStructName).toBe('NavMsg');
  });

  it('returns unresolved when impliedStructs is empty', () => {
    const td = makeTypeDict([]);
    const callNode = buildCallNode([ident('sock'), ident('id'), ident('buf'), ident('len')]);
    buildFnDef([], [], callNode);

    const result = resolvePayload(makeInput(callNode, 2, td, []));
    expect(result.strategy).toBe('unresolved');
    expect(result.confidence).toBe('unresolved');
  });
});

// ── Tests: missing payload arg ────────────────────────────────────────────────

describe('payloadResolver — edge cases', () => {
  it('returns unresolved when payloadArgIndex is out of range', () => {
    const td = makeTypeDict([]);
    const callNode = buildCallNode([ident('sock'), ident('id')]);
    buildFnDef([], [], callNode);

    const result = resolvePayload(makeInput(callNode, 5, td));
    expect(result.strategy).toBe('unresolved');
    expect(result.confidence).toBe('unresolved');
    expect(result.notes).toMatch(/not found/i);
  });

  it('records filename and line number', () => {
    const td = makeTypeDict([]);
    const callNode = buildCallNode([ident('sock'), ident('id'), ident('buf'), ident('len')], 42);
    buildFnDef([], [], callNode);

    const result = resolvePayload(makeInput(callNode, 2, td));
    expect(result.sendSiteFile).toBe('sender.c');
    expect(result.sendSiteLine).toBe(43); // row 42 → line 43 (1-based)
    expect(result.patternName).toBe('ipc_send');
  });
});

// ── Tests: Strategy 3b — prior assignment tracing ────────────────────────────

describe('payloadResolver — Strategy 3b: prior assignment', () => {
  it('resolves msgData = &ownship to OwnshipMsg (high confidence)', () => {
    const ownshipStruct = makeStruct('OwnshipMsg');
    const td = makeTypeDict([ownshipStruct]);

    // OwnshipMsg ownship;
    // msgData = &ownship;
    // send_message(handle, msgID, msgSize, msgData);
    const varDecl = declNode('OwnshipMsg', 'ownship');
    const assignment = assignStmt('msgData', addressOf(ident('ownship')));
    const callNode = buildCallNode([ident('handle'), ident('msgID'), ident('msgSize'), ident('msgData')]);
    buildFnDef([], [varDecl, assignment], callNode);

    const result = resolvePayload(makeInput(callNode, 3, td));
    expect(result.strategy).toBe('address-of');
    expect(result.confidence).toBe('high');
    expect(result.resolvedStructName).toBe('OwnshipMsg');
    expect(result.resolvedStruct).toBe(ownshipStruct);
  });

  it('resolves msgData = (NavMsg *)buf to NavMsg (medium confidence)', () => {
    const navStruct = makeStruct('NavMsg');
    const td = makeTypeDict([navStruct]);

    const assignment = assignStmt('msgData', castExpr('NavMsg *', ident('buf')));
    const callNode = buildCallNode([ident('handle'), ident('id'), ident('size'), ident('msgData')]);
    buildFnDef([], [assignment], callNode);

    const result = resolvePayload(makeInput(callNode, 3, td));
    expect(result.strategy).toBe('cast');
    expect(result.confidence).toBe('medium');
    expect(result.resolvedStructName).toBe('NavMsg');
  });

  it('resolves static local var declared in outer scope when call is nested', () => {
    // Mirrors: static ElemProc_PB pbProc; at function top, then
    // if (...) { register_callback(a, b, c, (SLEMR_PASSBACK) &pbProc); }
    const pbStruct = makeStruct('ElemProc_PB');
    const td = makeTypeDict([pbStruct]);

    const pbDecl = { ...declNode('ElemProc_PB', 'pbProc'), startIndex: 10 };

    const castArg = castExpr('SLEMR_PASSBACK', addressOf(ident('pbProc')));
    const callNode = buildCallNode([ident('a'), ident('b'), ident('c'), castArg]);
    callNode.startIndex = 200;

    // Inner compound_statement wrapping the call
    const innerExprStmt = mockNode('expression_statement', '', [callNode], {}, 200, 10);
    callNode.parent = innerExprStmt;
    const innerCompound = mockNode('compound_statement', '{}', [innerExprStmt], {}, 100, 5);
    innerExprStmt.parent = innerCompound;

    // Outer compound_statement: [pbDecl, if_statement containing innerCompound]
    const ifStmt = mockNode('if_statement', 'if(...){...}', [innerCompound], {}, 50, 3);
    innerCompound.parent = ifStmt;
    const outerCompound = mockNode('compound_statement', '{...}', [pbDecl, ifStmt], {}, 0, 0);
    pbDecl.parent = outerCompound;
    ifStmt.parent = outerCompound;

    // function_definition wrapping outerCompound
    const paramList = mockNode('parameter_list', '', []);
    const fnDecl = mockNode('function_declarator', 'fn()', [mockNode('identifier', 'fn'), paramList], { parameters: paramList });
    const retType = mockNode('primitive_type', 'void');
    const fnDef = mockNode('function_definition', 'void fn() {...}', [retType, fnDecl, outerCompound], { declarator: fnDecl });
    outerCompound.parent = fnDef;

    const result = resolvePayload(makeInput(callNode, 3, td));
    expect(result.strategy).toBe('pointer');
    expect(result.confidence).toBe('high');
    expect(result.resolvedStructName).toBe('ElemProc_PB');
    expect(result.resolvedStruct).toBe(pbStruct);
  });

  it('picks the most recent assignment when multiple exist', () => {
    const navStruct = makeStruct('NavMsg');
    const radarStruct = makeStruct('RadarMsg');
    const td = makeTypeDict([navStruct, radarStruct]);

    const decl1 = declNode('NavMsg', 'nav');
    const decl2 = declNode('RadarMsg', 'radar');
    // First assignment: msgData = &nav
    // Second (more recent): msgData = &radar — should win
    const assign1 = assignStmt('msgData', addressOf(ident('nav')));
    const assign2 = assignStmt('msgData', addressOf(ident('radar')));
    const callNode = buildCallNode([ident('h'), ident('id'), ident('sz'), ident('msgData')]);
    buildFnDef([], [decl1, decl2, assign1, assign2], callNode);

    const result = resolvePayload(makeInput(callNode, 3, td));
    expect(result.resolvedStructName).toBe('RadarMsg');
  });
});
