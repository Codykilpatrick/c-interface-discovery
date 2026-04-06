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
  direction: 'send' | 'recv' | 'bidirectional';
  notes: string;
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
}

export interface TypeDict {
  structs: CStruct[];
  enums: CEnum[];
  defines: CDefine[];
}

export interface StringAnalysis {
  files: FileAnalysis[];         // one per .c source file only
  typeDict: TypeDict;            // resolved from all headers + sources
  messageInterfaces: MessageInterface[];
  customPatterns: CustomPattern[];
  msgStructPatterns: MsgStructPattern[];
  warnings: AnalysisWarning[];   // global warnings shown in banner
}

export interface AnalysisWarning {
  kind: 'collision' | 'conflict' | 'encoding' | 'oversized' | 'circular-include' | 'ifdef-variant';
  message: string;
  files: string[];
}
