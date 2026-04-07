import type {
  CDefine,
  CStruct,
  CustomPattern,
  FileAnalysis,
  FileRef,
  IpcType,
  LoadedFile,
  MessageInterface,
  MsgDirection,
  MsgFileRole,
  MsgStructPattern,
  TypeDict,
} from './types';
import { findReferences } from '../utils/findReferences';

/**
 * Default name patterns that indicate a message type constant.
 * OP_* and CMD_* are intentionally excluded — they match too broadly
 * (e.g. MQTT opcode bitmasks). Add them via custom patterns if needed.
 */
const MSG_CONSTANT_PATTERNS = [
  /^MSG_TYPE_/,
  /^MSG_ID_/,
  /^PKT_TYPE_/,
  /^OPCODE_/,
];

/** IPC call names that are send-side. */
const SEND_CALLS = new Set([
  'send', 'sendto', 'write', 'mq_send', 'fwrite',
]);

/** IPC call names that are recv-side. */
const RECV_CALLS = new Set([
  'recv', 'recvfrom', 'read', 'mq_receive', 'fread',
]);

function isMsgConstant(name: string, customPatterns: CustomPattern[]): boolean {
  if (MSG_CONSTANT_PATTERNS.some((re) => re.test(name))) return true;
  return customPatterns.some((p) => {
    try { return new RegExp(p.pattern).test(name); } catch { return false; }
  });
}

function collectAllDefines(analyses: FileAnalysis[], typeDict: TypeDict): CDefine[] {
  const seen = new Set<string>();
  const result: CDefine[] = [];
  const add = (d: CDefine) => {
    if (!seen.has(d.name)) { seen.add(d.name); result.push(d); }
  };
  typeDict.defines.forEach(add);
  analyses.forEach((a) => a.defines.forEach(add));
  return result;
}

/**
 * Heuristic: derive likely struct name from a message constant.
 *
 * Examples:
 *   MSG_TYPE_ACOUSTIC → Acoustic, AcousticMsg, AcousticMessage
 *   CMD_FIRE          → Fire, FireCmd, FireCommand
 */
function candidateStructNames(constant: string): string[] {
  // Strip known prefixes
  const withoutPrefix = constant
    .replace(/^MSG_TYPE_|^MSG_ID_|^PKT_TYPE_|^OPCODE_/, '')
    .replace(/^CMD_|^OP_/, '');

  // Convert SCREAMING_SNAKE to PascalCase: ACOUSTIC_SAMPLE → AcousticSample
  const pascal = withoutPrefix
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');

  return [
    pascal,
    `${pascal}Msg`,
    `${pascal}Message`,
    `${pascal}Packet`,
    `${pascal}Data`,
  ];
}

function resolveStruct(constant: string, typeDict: TypeDict): CStruct | null {
  const candidates = candidateStructNames(constant);
  for (const name of candidates) {
    const found = typeDict.structs.find((s) => s.name === name);
    if (found) return found;
  }
  return null;
}

/**
 * Find source files that reference a constant, with line-level detail.
 * Uses findReferences() for whole-word matching and line number capture.
 * Filters to only files that are also in the analyses list.
 */
function filesUsingConstant(
  constant: string,
  analyses: FileAnalysis[],
  sourceFiles: LoadedFile[]
): FileRef[] {
  const analysedNames = new Set(analyses.map((a) => a.filename));
  return findReferences(constant, sourceFiles).filter((r) => analysedNames.has(r.filename));
}

/**
 * Infer message direction from IPC calls in files that reference the constant.
 * Reuses the FileRef list already computed by filesUsingConstant.
 */
function inferDirection(
  refs: FileRef[],
  analyses: FileAnalysis[]
): { direction: MsgDirection; confident: boolean; transport: IpcType | null } {
  let hasSend = false;
  let hasRecv = false;
  let transport: IpcType | null = null;

  const referencingFiles = new Set(refs.map((r) => r.filename));

  for (const a of analyses) {
    if (!referencingFiles.has(a.filename)) continue;

    for (const ipcCall of a.ipc) {
      const callName = ipcCall.detail.split('(')[0].trim().toLowerCase();
      const isSend = SEND_CALLS.has(callName) || ipcCall.type === 'socket-send' || ipcCall.type === 'mqueue'
        || ipcCall.direction === 'send' || ipcCall.direction === 'bidirectional';
      const isRecv = RECV_CALLS.has(callName) || ipcCall.type === 'socket-recv'
        || ipcCall.direction === 'recv' || ipcCall.direction === 'bidirectional';
      if (isSend) { hasSend = true; transport = ipcCall.type; }
      if (isRecv) { hasRecv = true; transport = transport ?? ipcCall.type; }
    }
  }

  if (hasSend && hasRecv) return { direction: 'both', confident: true, transport };
  if (hasSend) return { direction: 'producer', confident: true, transport };
  if (hasRecv) return { direction: 'consumer', confident: true, transport };
  return { direction: 'unknown', confident: false, transport };
}

/**
 * For each file referencing the constant, determine whether it is a
 * producer, consumer, or both based on its own IPC calls.
 */
function computeFileRoles(refs: FileRef[], analyses: FileAnalysis[]): MsgFileRole[] {
  const analysisByFile = new Map(analyses.map((a) => [a.filename, a]));
  const roles: MsgFileRole[] = [];

  for (const ref of refs) {
    const a = analysisByFile.get(ref.filename);
    if (!a) continue;

    let hasSend = false;
    let hasRecv = false;
    for (const ipcCall of a.ipc) {
      const name = ipcCall.detail.split('(')[0].trim().toLowerCase();
      // Check by call name, IPC type, or explicit direction from custom patterns
      if (SEND_CALLS.has(name) || ipcCall.type === 'socket-send' || ipcCall.type === 'mqueue'
          || ipcCall.direction === 'send' || ipcCall.direction === 'bidirectional') {
        hasSend = true;
      }
      if (RECV_CALLS.has(name) || ipcCall.type === 'socket-recv'
          || ipcCall.direction === 'recv' || ipcCall.direction === 'bidirectional') {
        hasRecv = true;
      }
    }

    // Always include files that reference the constant — if direction is
    // indeterminate (e.g. uses wrapper functions), fall back to 'both' so
    // the graph still draws an edge rather than silently dropping the file.
    if (hasSend && hasRecv) roles.push({ filename: ref.filename, role: 'both' });
    else if (hasSend)        roles.push({ filename: ref.filename, role: 'producer' });
    else if (hasRecv)        roles.push({ filename: ref.filename, role: 'consumer' });
    else                     roles.push({ filename: ref.filename, role: 'both' });
  }

  return roles;
}

/**
 * Build MessageInterface entries for structs whose names match user-supplied
 * MsgStructPattern regexes.  Entries are keyed by struct name and deduplicated
 * so multiple overlapping patterns never produce duplicates.
 */
function extractStructBasedInterfaces(
  analyses: FileAnalysis[],
  typeDict: TypeDict,
  structPatterns: MsgStructPattern[],
  sourceFiles: LoadedFile[]
): MessageInterface[] {
  if (structPatterns.length === 0) return [];

  const result: MessageInterface[] = [];
  const seen = new Set<string>(); // dedup by struct name

  for (const sp of structPatterns) {
    let re: RegExp;
    try {
      re = new RegExp(sp.pattern);
    } catch {
      continue; // invalid regex — skip silently
    }

    for (const struct of typeDict.structs) {
      if (!re.test(struct.name)) continue;
      if (seen.has(struct.name)) continue;
      seen.add(struct.name);

      const allRefs = filesUsingConstant(struct.name, analyses, sourceFiles);
      const usedIn = allRefs.filter((r) => r.filename !== struct.sourceFile);
      const { direction, confident, transport } = inferDirection(allRefs, analyses);
      const fileRoles = computeFileRoles(allRefs, analyses);

      result.push({
        msgTypeConstant: struct.name,
        msgTypeValue: '(struct)',
        struct,
        structResolved: true,
        direction,
        directionConfident: confident,
        transport,
        definedIn: struct.sourceFile,
        usedIn,
        fileRoles,
      });
    }
  }

  return result;
}

export function extractMessageInterfaces(
  analyses: FileAnalysis[],
  typeDict: TypeDict,
  patterns: CustomPattern[],
  sourceFiles: LoadedFile[] = [],
  msgStructPatterns: MsgStructPattern[] = []
): MessageInterface[] {
  const allDefines = collectAllDefines(analyses, typeDict);
  const msgConstants = allDefines.filter((d) => isMsgConstant(d.name, patterns));

  const defineBasedInterfaces = msgConstants.map((def): MessageInterface => {
    const struct = resolveStruct(def.name, typeDict);
    const allRefs = filesUsingConstant(def.name, analyses, sourceFiles);
    const usedIn = allRefs.filter((r) => r.filename !== def.sourceFile);
    const { direction, confident, transport } = inferDirection(allRefs, analyses);
    const fileRoles = computeFileRoles(allRefs, analyses);

    return {
      msgTypeConstant: def.name,
      msgTypeValue: def.value,
      struct,
      structResolved: struct !== null,
      direction,
      directionConfident: confident,
      transport,
      definedIn: def.sourceFile,
      usedIn,
      fileRoles,
    };
  });

  const structBasedInterfaces = extractStructBasedInterfaces(
    analyses, typeDict, msgStructPatterns, sourceFiles
  );

  // Exclude struct-based entries whose name already appears as a define-based entry
  const defineNames = new Set(defineBasedInterfaces.map((m) => m.msgTypeConstant));
  const uniqueStructInterfaces = structBasedInterfaces.filter(
    (m) => !defineNames.has(m.msgTypeConstant)
  );

  return [...defineBasedInterfaces, ...uniqueStructInterfaces];
}
