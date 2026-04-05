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
      if (SEND_CALLS.has(callName)) {
        hasSend = true;
        transport = ipcCall.type;
      }
      if (RECV_CALLS.has(callName)) {
        hasRecv = true;
        transport = transport ?? ipcCall.type;
      }
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
      if (SEND_CALLS.has(name)) hasSend = true;
      if (RECV_CALLS.has(name)) hasRecv = true;
    }

    if (hasSend && hasRecv) roles.push({ filename: ref.filename, role: 'both' });
    else if (hasSend)        roles.push({ filename: ref.filename, role: 'producer' });
    else if (hasRecv)        roles.push({ filename: ref.filename, role: 'consumer' });
    // files that reference the constant but have no send/recv are omitted
  }

  return roles;
}

export function extractMessageInterfaces(
  analyses: FileAnalysis[],
  typeDict: TypeDict,
  patterns: CustomPattern[],
  sourceFiles: LoadedFile[] = []
): MessageInterface[] {
  const allDefines = collectAllDefines(analyses, typeDict);
  const msgConstants = allDefines.filter((d) => isMsgConstant(d.name, patterns));

  return msgConstants.map((def): MessageInterface => {
    // Step 2: attempt struct resolution
    const struct = resolveStruct(def.name, typeDict);

    // Step 3+4: find all source files referencing this constant (with line numbers)
    const allRefs = filesUsingConstant(def.name, analyses, sourceFiles);
    const usedIn = allRefs.filter((r) => r.filename !== def.sourceFile);

    // Step 3: direction inference + per-file roles
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
}
