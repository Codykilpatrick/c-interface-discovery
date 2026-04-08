import type Parser from 'web-tree-sitter';
import type {
  CDefine,
  CEnum,
  CFunction,
  CParam,
  CStruct,
  CustomPattern,
  Direction,
  FileAnalysis,
  IpcCall,
  IpcType,
  LoadedFile,
  RiskFlag,
  Severity,
  TypeDict,
} from './types';
import { extractConditionalBlocks } from './preprocessor';

// ─── IPC call name → IpcType mapping ─────────────────────────────────────────

const IPC_CALLS: Record<string, IpcType> = {
  socket: 'socket',
  connect: 'socket',
  bind: 'socket',
  listen: 'socket',
  accept: 'socket',
  send: 'socket-send',
  sendto: 'socket-send',
  recv: 'socket-recv',
  recvfrom: 'socket-recv',
  pipe: 'pipe',
  mkfifo: 'fifo',
  shmget: 'shared-mem',
  shmat: 'shared-mem',
  shmdt: 'shared-mem',
  shmctl: 'shared-mem',
  shm_open: 'shared-mem',
  mq_open: 'mqueue',
  mq_send: 'mqueue',
  mq_receive: 'mqueue',
  sem_open: 'semaphore',
  semget: 'semaphore',
  sem_wait: 'semaphore',
  sem_post: 'semaphore',
  signal: 'signal',
  kill: 'signal',
  sigaction: 'signal',
  pthread_create: 'thread',
  pthread_join: 'thread',
  fork: 'process-fork',
  execv: 'process-exec',
  execl: 'process-exec',
  execvp: 'process-exec',
  system: 'process-exec',
  write: 'file-io',
  read: 'file-io',
  ioctl: 'ioctl',
  open: 'file-io',
  fopen: 'file-io',
};

// Standard library functions to ignore in unknownCalls
const STDLIB_IGNORE = new Set([
  'printf', 'fprintf', 'sprintf', 'snprintf', 'scanf', 'sscanf', 'fscanf',
  'malloc', 'calloc', 'realloc', 'free',
  'memcpy', 'memmove', 'memset', 'memcmp',
  'strcpy', 'strncpy', 'strcat', 'strncat', 'strcmp', 'strncmp', 'strlen', 'strchr', 'strstr',
  'gets', 'fgets', 'puts', 'fputs',
  'fread', 'fwrite', 'fclose', 'fflush', 'fseek', 'ftell', 'rewind', 'feof',
  'exit', 'abort', 'assert',
  'atoi', 'atol', 'atof', 'strtol', 'strtod',
  'time', 'clock', 'sleep', 'usleep',
  'perror', 'strerror', 'errno',
  'abs', 'labs', 'rand', 'srand',
]);

// Risk patterns: { test, severity, msg }
const RISK_PATTERNS: { test: (name: string) => boolean; severity: Severity; msg: string }[] = [
  { test: (n) => n === 'gets', severity: 'high', msg: 'Use of gets() — unsafe, no bounds checking' },
  { test: (n) => n === 'strcpy', severity: 'high', msg: 'Use of strcpy() — potential buffer overflow' },
  { test: (n) => n === 'sprintf', severity: 'medium', msg: 'Use of sprintf() — prefer snprintf' },
  { test: (n) => n === 'printf', severity: 'low', msg: 'Use of printf() — avoid in production firmware' },
];

// ─── Tree-sitter query strings ────────────────────────────────────────────────

const FUNCTION_DEF_QUERY = `
(function_definition
  type: (_) @return_type
  declarator: (function_declarator
    declarator: (identifier) @name
    parameters: (parameter_list) @params))
`;

const EXTERN_QUERY = `
(declaration
  (storage_class_specifier) @storage
  type: (_) @type
  declarator: (identifier) @name)
`;

const CALL_EXPR_QUERY = `
(call_expression
  function: (identifier) @callee)
`;

const INCLUDE_QUERY = `
(preproc_include
  path: (_) @path)
`;

// ─── Helper functions ─────────────────────────────────────────────────────────

function nodeText(node: Parser.SyntaxNode): string {
  return node.text.trim();
}

function parseParams(paramsNode: Parser.SyntaxNode): CParam[] {
  const params: CParam[] = [];
  for (const child of paramsNode.children) {
    if (child.type === 'parameter_declaration') {
      const typeNode = child.childForFieldName('type') ?? child.children[0];
      const declNode = child.childForFieldName('declarator') ?? child.children[child.children.length - 1];
      const typStr = typeNode ? nodeText(typeNode) : 'void';
      const nameStr = declNode && declNode !== typeNode ? nodeText(declNode).replace(/^\*+/, '') : '';
      params.push({ type: typStr, name: nameStr });
    }
  }
  return params;
}

function defineCategory(name: string, value: string): CDefine['category'] {
  if (/port|addr|ip|host/i.test(name) || /^0x[\dA-Fa-f]+$/.test(value)) return 'network';
  if (/size|len|max|min|buf|count/i.test(name)) return 'sizing';
  if (/flag|mask|bit|mode/i.test(name)) return 'flags';
  if (/type|id|op|cmd|msg|pkt/i.test(name)) return 'protocol';
  return 'other';
}

function parseDefines(content: string, sourceFile: string, conditional: boolean): CDefine[] {
  const defines: CDefine[] = [];
  const re = /^[ \t]*#\s*define\s+(\w+)\s+(.+?)(?:\s*\/\/.*)?$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    defines.push({
      name: m[1],
      value: m[2].trim(),
      category: defineCategory(m[1], m[2].trim()),
      sourceFile,
      conditional,
    });
  }
  return defines;
}

// ─── Main analyzer ────────────────────────────────────────────────────────────

export async function analyzeSource(
  file: LoadedFile,
  parser: Parser,
  typeDict: TypeDict,
  patterns: CustomPattern[]
): Promise<FileAnalysis> {
  const tree = parser.parse(file.content);
  const root = tree.rootNode;
  const lang = parser.getLanguage();

  const functions: CFunction[] = [];
  const externs: FileAnalysis['externs'] = [];
  const structs: CStruct[] = [];
  const enums: CEnum[] = [];
  const defines: CDefine[] = [];
  const ipc: IpcCall[] = [];
  const includes: FileAnalysis['includes'] = [];
  const risks: RiskFlag[] = [];
  const calledNames = new Set<string>();
  const localFunctionNames = new Set<string>();

  // ── Function definitions ───────────────────────────────────────────────
  try {
    const fnQuery = lang.query(FUNCTION_DEF_QUERY);
    for (const match of fnQuery.matches(root)) {
      const nameCapture = match.captures.find((c) => c.name === 'name');
      const retCapture = match.captures.find((c) => c.name === 'return_type');
      const paramsCapture = match.captures.find((c) => c.name === 'params');
      if (!nameCapture) continue;

      const name = nodeText(nameCapture.node);
      const returnType = retCapture ? nodeText(retCapture.node) : 'void';
      const params = paramsCapture ? parseParams(paramsCapture.node) : [];

      // Determine direction: static → internal, otherwise exported
      const funcNode = nameCapture.node.parent?.parent;
      const isStatic = funcNode?.children.some(
        (c) => c.type === 'storage_class_specifier' && c.text === 'static'
      ) ?? false;
      const direction: Direction = isStatic ? 'internal' : 'exported';

      functions.push({ name, returnType, params, direction });
      localFunctionNames.add(name);
    }
  } catch {
    // Continue on query failure
  }

  // ── Extern declarations ────────────────────────────────────────────────
  try {
    const extQuery = lang.query(EXTERN_QUERY);
    for (const match of extQuery.matches(root)) {
      const storageCapture = match.captures.find((c) => c.name === 'storage');
      if (!storageCapture || storageCapture.node.text !== 'extern') continue;
      const nameCapture = match.captures.find((c) => c.name === 'name');
      const typeCapture = match.captures.find((c) => c.name === 'type');
      if (!nameCapture) continue;

      const name = nodeText(nameCapture.node);
      const dataType = typeCapture ? nodeText(typeCapture.node) : 'unknown';
      // Heuristic: if type looks like a function pointer it's a function, else variable
      const kind: 'function' | 'variable' =
        file.content.includes(`(*${name})`) ? 'function' : 'variable';
      externs.push({ name, dataType, kind });
    }
  } catch {
    // Continue
  }

  // ── Includes ──────────────────────────────────────────────────────────
  try {
    const inclQuery = lang.query(INCLUDE_QUERY);
    for (const match of inclQuery.matches(root)) {
      const pathCapture = match.captures.find((c) => c.name === 'path');
      if (!pathCapture) continue;
      const raw = nodeText(pathCapture.node);
      const isLocal = raw.startsWith('"');
      const path = raw.replace(/^["<]|[">]$/g, '');
      includes.push({ path, isLocal });
    }
  } catch {
    // Continue
  }

  // ── Call expressions → IPC + unknown calls ────────────────────────────
  try {
    const callQuery = lang.query(CALL_EXPR_QUERY);
    for (const match of callQuery.matches(root)) {
      const calleeCapture = match.captures.find((c) => c.name === 'callee');
      if (!calleeCapture) continue;
      const name = nodeText(calleeCapture.node);
      calledNames.add(name);

      // IPC detection
      const ipcType = IPC_CALLS[name];
      if (ipcType) {
        // Get the parent call_expression text for detail
        const callNode = calleeCapture.node.parent;
        const detail = callNode ? nodeText(callNode).substring(0, 120) : name;
        if (!ipc.some((c) => c.type === ipcType && c.detail === detail)) {
          ipc.push({ type: ipcType, detail });
        }
      }

      // Risk patterns
      for (const risk of RISK_PATTERNS) {
        if (risk.test(name) && !risks.some((r) => r.msg === risk.msg)) {
          risks.push({ severity: risk.severity, msg: risk.msg });
        }
      }
    }
  } catch {
    // Continue
  }

  // ── Custom pattern matching ────────────────────────────────────────────
  for (const pattern of patterns) {
    try {
      const re = new RegExp(pattern.pattern, 'g');
      const matches = file.content.match(re);
      if (matches && matches.length > 0) {
        ipc.push({
          type: pattern.ipcType,
          detail: `${pattern.name} (custom pattern, ${matches.length} match${matches.length > 1 ? 'es' : ''})`,
          direction: pattern.direction,
          isExternal: pattern.isExternal,
          externalName: pattern.externalName,
        });
      }
    } catch {
      // Invalid regex — ignore
    }
  }

  // ── Defines ───────────────────────────────────────────────────────────
  const preResult = extractConditionalBlocks(file.content);
  const topLevelDefs = parseDefines(file.content, file.filename, false);
  defines.push(...topLevelDefs);
  if (preResult.hasConditionals) {
    for (const block of preResult.blocks) {
      for (const branchText of block.branchTexts) {
        const branchDefs = parseDefines(branchText, file.filename, true);
        for (const d of branchDefs) {
          if (!defines.some((x) => x.name === d.name)) {
            defines.push(d);
          }
        }
      }
    }
  }

  // ── Unknown external calls ─────────────────────────────────────────────
  const knownTypeNames = new Set([
    ...typeDict.structs.map((s) => s.name),
    ...typeDict.enums.map((e) => e.name),
  ]);
  const unknownCalls: string[] = [];
  for (const name of calledNames) {
    const matchesCustomPattern = patterns.some((p) => {
      try { return new RegExp(p.pattern).test(`${name}(`); } catch { return false; }
    });
    if (
      !localFunctionNames.has(name) &&
      !STDLIB_IGNORE.has(name) &&
      !(name in IPC_CALLS) &&
      !knownTypeNames.has(name) &&
      !RISK_PATTERNS.some((r) => r.test(name)) &&
      !matchesCustomPattern
    ) {
      unknownCalls.push(name);
    }
  }

  // ── Risk: high extern count ────────────────────────────────────────────
  if (externs.length > 20) {
    risks.push({ severity: 'medium', msg: `High extern count (${externs.length}) — may indicate tight coupling` });
  }

  // ── Risk: hardcoded hex constants ─────────────────────────────────────
  const hexMatches = file.content.match(/\b0x[0-9A-Fa-f]{4,}\b/g);
  if (hexMatches && hexMatches.length > 5) {
    risks.push({ severity: 'low', msg: `${hexMatches.length} hardcoded hex constants — check for magic numbers` });
  }

  // ── Risk: malloc without free ─────────────────────────────────────────
  if (calledNames.has('malloc') && !calledNames.has('free')) {
    risks.push({ severity: 'medium', msg: 'malloc() called without free() — potential memory leak' });
  }

  // ── Encoding warning ──────────────────────────────────────────────────
  const riskWarnings: RiskFlag[] = [];
  if (file.encoding === 'latin-1') {
    riskWarnings.push({ severity: 'low', msg: `File decoded as Latin-1 — verify special characters` });
    risks.push(...riskWarnings);
  }

  return {
    filename: file.filename,
    role: 'source',
    functions,
    externs,
    structs,
    enums,
    defines,
    ipc,
    includes,
    risks,
    unknownCalls,
  };
}
