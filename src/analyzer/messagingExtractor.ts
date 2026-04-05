import type {
  CDefine,
  CStruct,
  CustomPattern,
  FileAnalysis,
  IpcType,
  LoadedFile,
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
 * Find source files that reference a constant by scanning raw content.
 * Constants are typically defined in headers, so we can't rely on
 * FileAnalysis.defines — instead we text-search the source content.
 */
function filesUsingConstant(
  constant: string,
  analyses: FileAnalysis[],
  sourceFiles: LoadedFile[]
): string[] {
  // Build a map from filename to content for O(1) lookup
  const contentByFile = new Map(sourceFiles.map((f) => [f.filename, f.content]));

  return analyses
    .filter((a) => {
      const content = contentByFile.get(a.filename);
      return content !== undefined && content.includes(constant);
    })
    .map((a) => a.filename);
}

/**
 * Infer message direction from IPC calls in files that reference the constant.
 * Uses raw source content to find which files use the constant (handles the
 * common case where constants are defined in headers, not source files).
 */
function inferDirection(
  constant: string,
  analyses: FileAnalysis[],
  sourceFiles: LoadedFile[]
): { direction: MsgDirection; confident: boolean; transport: IpcType | null } {
  let hasSend = false;
  let hasRecv = false;
  let transport: IpcType | null = null;

  const contentByFile = new Map(sourceFiles.map((f) => [f.filename, f.content]));

  for (const a of analyses) {
    const content = contentByFile.get(a.filename);
    if (!content || !content.includes(constant)) continue;

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
  patterns: CustomPattern[],
  sourceFiles: LoadedFile[] = []
): MessageInterface[] {
  const allDefines = collectAllDefines(analyses, typeDict);
  const msgConstants = allDefines.filter((d) => isMsgConstant(d.name, patterns));

  return msgConstants.map((def): MessageInterface => {
    // Step 2: attempt struct resolution
    const struct = resolveStruct(def.name, typeDict);

    // Step 3: direction inference (text-search source content for constant references)
    const { direction, confident, transport } = inferDirection(def.name, analyses, sourceFiles);

    // Step 4: files referencing this constant
    const usedIn = filesUsingConstant(def.name, analyses, sourceFiles)
      .filter((f) => f !== def.sourceFile);

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
