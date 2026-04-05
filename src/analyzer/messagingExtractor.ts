import type {
  CDefine,
  CStruct,
  CustomPattern,
  FileAnalysis,
  IpcType,
  MessageInterface,
  MsgDirection,
  TypeDict,
} from './types';

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
 * Determine which source files actually reference a constant by scanning
 * raw content (Phase 4 heuristic; tree-sitter AST would be more precise).
 */
function filesUsingConstant(constant: string, analyses: FileAnalysis[]): string[] {
  return analyses
    .filter((a) => {
      // Check if defined in this file's defines list (already captured by source analyzer)
      const inDefines = a.defines.some((d) => d.name === constant);
      // OR referenced in raw IPC call details — we don't have raw content here,
      // so we rely on what sourceAnalyzer captured.
      return inDefines;
    })
    .map((a) => a.filename);
}

/**
 * Infer message direction from IPC calls in the analyses.
 * If any send-side call appears alongside the constant → producer
 * If any recv-side call appears → consumer
 * Both → both
 */
function inferDirection(
  constant: string,
  analyses: FileAnalysis[]
): { direction: MsgDirection; confident: boolean; transport: IpcType | null } {
  let hasSend = false;
  let hasRecv = false;
  let transport: IpcType | null = null;

  for (const a of analyses) {
    const definesConstant = a.defines.some((d) => d.name === constant);
    if (!definesConstant) continue;

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

export function extractMessageInterfaces(
  analyses: FileAnalysis[],
  typeDict: TypeDict,
  patterns: CustomPattern[]
): MessageInterface[] {
  const allDefines = collectAllDefines(analyses, typeDict);
  const msgConstants = allDefines.filter((d) => isMsgConstant(d.name, patterns));

  return msgConstants.map((def): MessageInterface => {
    // Step 2: attempt struct resolution
    const struct = resolveStruct(def.name, typeDict);

    // Step 3: direction inference
    const { direction, confident, transport } = inferDirection(def.name, analyses);

    // Step 4: files referencing this constant
    const usedIn = filesUsingConstant(def.name, analyses).filter((f) => f !== def.sourceFile);

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
    };
  });
}
