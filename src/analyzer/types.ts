export type FileRole = 'source' | 'string-header' | 'external-header';
export type FileZone = 'string' | 'external';
export type Direction = 'exported' | 'internal' | 'imported';
export type IpcType =
  | 'socket' | 'socket-send' | 'socket-recv'
  | 'shared-mem' | 'pipe' | 'fifo' | 'mqueue'
  | 'semaphore' | 'signal' | 'thread' | 'process-fork'
  | 'process-exec' | 'file-io' | 'ioctl' | 'custom';
export type MsgDirection = 'producer' | 'consumer' | 'both' | 'unknown';
export type Severity = 'high' | 'medium' | 'low';

export interface LoadedFile {
  filename: string;
  content: string;           // normalized: LF line endings, UTF-8 or Latin-1 decoded
  zone: FileZone;
  encoding: 'utf-8' | 'latin-1';
  sizeBytes: number;
  oversized: boolean;        // true if between 500KB–2MB (warn)
  rejected: boolean;         // true if >2MB or binary/empty (error, skip analysis)
  rejectionReason?: string;
}

export interface FileRegistryEntry {
  file: LoadedFile;
  shadowedBy?: string;       // filename that won this collision, if any
}

export interface CParam {
  type: string;
  name: string;
}

export interface CFunction {
  name: string;
  returnType: string;
  params: CParam[];
  direction: Direction;
}

export interface CField {
  type: string;
  name: string;
}

export interface CStruct {
  name: string;
  fields: CField[];
  sourceFile: string;
  conditional: boolean;      // defined inside #ifdef block
  variants?: CStruct[];      // all conditional variants if multiple exist
  conflictsWith?: string[];  // other filenames defining same name differently
}

export interface CEnum {
  name: string;
  values: string[];
  sourceFile: string;
  conditional: boolean;
  variants?: CEnum[];
  conflictsWith?: string[];
}

export interface CDefine {
  name: string;
  value: string;
  category: 'network' | 'sizing' | 'flags' | 'protocol' | 'other';
  sourceFile: string;
  conditional: boolean;
}

export interface IpcCall {
  type: IpcType;
  detail: string;
  /** Explicit direction from a custom pattern — overrides type-based heuristics. */
  direction?: 'send' | 'recv' | 'bidirectional' | 'control';
  /** ALL_CAPS constant identifiers passed as arguments to this custom IPC call, found in typeDict.defines. */
  msgConstants?: string[];
  /** ALL_CAPS constant identifiers passed as arguments that were NOT found in typeDict.defines (missing headers). */
  missingConstants?: string[];
  /** Struct type names found in the containing wrapper function's parameter list. */
  impliedStructs?: string[];
  /** Param type names from IPC wrapper params that were NOT found in typeDict (unresolved external structs). */
  candidateTypes?: string[];
}

export interface CodeLine {
  lineNumber: number;   // 1-based
  text: string;         // trimmed source line
}

export interface FileRef {
  filename: string;
  lines: CodeLine[];
}

export interface MsgFileRole {
  filename: string;
  role: 'producer' | 'consumer' | 'both';
}

export interface MessageInterface {
  msgTypeConstant: string;      // e.g. MSG_TYPE_ACOUSTIC
  msgTypeValue: string;         // e.g. 0x01
  struct: CStruct | null;       // resolved struct, null if not found
  structResolved: boolean;      // false = show "not resolved" warning
  direction: MsgDirection;
  directionConfident: boolean;  // false = show "manual review needed"
  transport: IpcType | null;
  definedIn: string;
  usedIn: FileRef[];            // files that reference this constant, with line numbers
  fileRoles: MsgFileRole[];     // per-file producer/consumer role for graph edges
  incomplete?: boolean;         // true when only producers or only consumers found in loaded files
}

export interface RiskFlag {
  severity: Severity;
  msg: string;
}

export interface CustomPattern {
  id: string;
  name: string;
  pattern: string;           // regex string
  ipcType: IpcType;
  direction: 'send' | 'recv' | 'bidirectional' | 'control';
  notes: string;
  /** 0-based index of the argument holding the message ID constant. When set, Strategy A
   *  only extracts from this position and uses a relaxed identifier regex (not ALL_CAPS). */
  msgArgIndex?: number;
  /** Regex tested against extracted identifier names to classify them as message constants.
   *  Used by isMsgConstant() in addition to the built-in MSG_TYPE_ / MSG_ID_ prefixes. */
  msgConstantPattern?: string;
  /** 0-based index of the callback function argument. When set, Strategy C looks up that
   *  function's definition to extract its parameter struct types. */
  callbackArgIndex?: number;
  /** 0-based index of the payload pointer/buffer argument (Interface Mode: payload type resolution). */
  payloadArgIndex?: number;
  /** 0-based index of the length/size argument (Interface Mode). */
  lengthArgIndex?: number;
  /** Name of another registered pattern this wraps (Interface Mode). */
  isWrapperFor?: string;
  /** Auto-detected as a transitive wrapper around a registered IPC function (Interface Mode). */
  wrapperDetected?: boolean;
}

export interface MsgStructPattern {
  id: string;
  name: string;    // human label
  pattern: string; // regex tested against struct names in typeDict
}

export interface FileAnalysis {
  filename: string;
  role: FileRole;
  functions: CFunction[];
  externs: { name: string; dataType: string; kind: 'function' | 'variable' }[];
  structs: CStruct[];
  enums: CEnum[];
  defines: CDefine[];
  ipc: IpcCall[];
  includes: { path: string; isLocal: boolean }[];
  risks: RiskFlag[];
  unknownCalls: string[];
  payloadResolutions?: import('./payloadResolver').PayloadResolution[];
}

export interface TypeDict {
  structs: CStruct[];
  enums: CEnum[];
  defines: CDefine[];
  /** Plain typedef aliases: alias → canonical name. e.g. PASSBACK → DIST_PASSBACK */
  typedefAliases?: Record<string, string>;
}

export interface HeaderGenType {
  name: string;
  file: string;
  reachedFrom: string[];
}

export interface HeaderGenReview {
  kind: 'unresolved-type' | 'unresolved-include' | 'ambiguous-include' | 'source-root';
  message: string;
}

export interface HeaderGenBundle {
  root: string[];
  input: string[];
  /** Parent directories of `input` — pass these as header-gen `--input` (it walks each tree). */
  inputDirs: string[];
  include: string[];
  includeDirs: string[];
  types: HeaderGenType[];
  review: HeaderGenReview[];
}

export interface StringAnalysis {
  files: FileAnalysis[];         // one per .c source file only
  typeDict: TypeDict;            // resolved from all headers + sources
  messageInterfaces: MessageInterface[];
  customPatterns: CustomPattern[];
  msgStructPatterns: MsgStructPattern[];
  warnings: AnalysisWarning[];   // global warnings shown in banner
  structCatalog?: import('./structLayoutEngine').StructCatalog;
  layoutTarget?: '32bit' | '64bit';
  payloadResolutions?: import('./payloadResolver').PayloadResolution[];
  headerGenBundle?: HeaderGenBundle;
}

export interface AnalysisWarning {
  kind: 'collision' | 'conflict' | 'encoding' | 'oversized' | 'circular-include' | 'ifdef-variant';
  message: string;
  files: string[];
}

export interface ApplicationGroup {
  id: string;
  name: string;
  files: LoadedFile[];
  analysis: StringAnalysis | null;
}
