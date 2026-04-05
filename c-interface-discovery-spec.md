# C Interface Discovery Tool — Project Spec

## Overview

A static analysis web application for mapping messaging interfaces in legacy C
submarine combat system codebases. Targets one string at a time (SA, TA, fire
control, etc.). Runs 100% in the browser — zero network calls, zero backend.
Deployable as a Docker container for airgapped environments. Container ships
with full source so small changes can be made and rebuilt without a retransfer.

No C build tooling required. Analysis is pure TypeScript string parsing
augmented by Tree-sitter WASM for accurate C syntax parsing.

---

## Tech Stack

- **React 18** with **TypeScript** (strict mode)
- **Vite** for build tooling
- **Tree-sitter WASM** (tree-sitter-c grammar) for C parsing — runs fully
  in-browser, bundled into the Docker image at build time, zero runtime network
- **Docker + nginx** for airgapped deployment
- **No backend** — all analysis runs client-side
- **No clang** — tree-sitter parses syntax only, no compilation environment needed

---

## Project Structure

```
c-interface-discovery/
├── src/
│   ├── analyzer/
│   │   ├── types.ts                  # All shared TypeScript types
│   │   ├── fileIngestion.ts          # Load files, normalize encoding + line endings
│   │   ├── fileClassifier.ts         # Sort .c vs string .h vs external .h
│   │   ├── fileRegistry.ts           # Collision detection, deduplication, removal
│   │   ├── headerParser.ts           # Extract structs/enums/defines from headers
│   │   ├── sourceAnalyzer.ts         # Full analysis pass on .c files
│   │   ├── messagingExtractor.ts     # Correlate msg enums + structs + transports
│   │   ├── preprocessor.ts           # #ifdef/#else/#endif branch handling
│   │   ├── patternRegistry.ts        # Custom call pattern management
│   │   └── index.ts                  # Orchestrates all passes, exports analyzeString()
│   ├── components/
│   │   ├── DropZone.tsx              # Two-zone layout: string files + external includes
│   │   ├── FileList.tsx              # Per-zone loaded file list with remove (X) buttons
│   │   ├── SummaryBar.tsx
│   │   ├── FileTabs.tsx
│   │   ├── WarningBanner.tsx         # Collision / conflict / encoding warnings
│   │   ├── sections/
│   │   │   ├── MessagingSection.tsx  # Primary deliverable — message interface cards
│   │   │   ├── FunctionsSection.tsx
│   │   │   ├── IpcSection.tsx
│   │   │   ├── StructsSection.tsx
│   │   │   ├── ExternsSection.tsx
│   │   │   ├── DefinesSection.tsx
│   │   │   ├── UnknownsSection.tsx
│   │   │   └── RiskSection.tsx
│   │   ├── PatternRegistry.tsx       # UI for adding/editing/exporting custom patterns
│   │   └── Accordion.tsx
│   ├── App.tsx
│   └── main.tsx
├── Dockerfile                        # Dev container — ships source + Node + nginx
├── nginx.conf
├── vite.config.ts
├── tsconfig.json
└── package.json
```

---

## Core Types (src/analyzer/types.ts)

```typescript
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

export interface MessageInterface {
  msgTypeConstant: string;      // e.g. MSG_TYPE_ACOUSTIC
  msgTypeValue: string;         // e.g. 0x01
  struct: CStruct | null;       // resolved struct, null if not found
  structResolved: boolean;      // false = show "not resolved" warning
  direction: MsgDirection;
  directionConfident: boolean;  // false = show "manual review needed"
  transport: IpcType | null;
  definedIn: string;
  usedIn: string[];
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
  warnings: AnalysisWarning[];   // global warnings shown in banner
}

export interface AnalysisWarning {
  kind: 'collision' | 'conflict' | 'encoding' | 'oversized' | 'circular-include' | 'ifdef-variant';
  message: string;
  files: string[];
}
```

---

## File Ingestion (src/analyzer/fileIngestion.ts)

Runs before any analysis. Applied to every file in both zones.

### Encoding Detection
1. Read file as `ArrayBuffer`
2. Scan for null bytes or high ratio of non-printable characters →
   mark `rejected: true`, `rejectionReason: 'binary file'`, skip
3. Try decode as UTF-8 via `TextDecoder('utf-8', { fatal: true })`
4. If that throws, fall back to `TextDecoder('iso-8859-1')`
5. Record which encoding was used, emit `encoding` warning if Latin-1

### Line Ending Normalization
After decode: `.replace(/\r\n/g, '\n').replace(/\r/g, '\n')`
Applied universally before any analysis pass.

### Size Checks
- Empty file (0 bytes after decode) → `rejected: true`, `rejectionReason: 'empty file'`
- `> 2MB` → `rejected: true`, `rejectionReason: 'file too large (>2MB)'`
- `500KB–2MB` → `oversized: true`, emit oversized warning, analyze in Web Worker

### Binary Detection Heuristic
Count non-printable, non-whitespace bytes in first 8KB sample.
If ratio `> 0.1` (10%) treat as binary and reject.

---

## File Registry (src/analyzer/fileRegistry.ts)

Maintains the canonical list of loaded files across both zones.
All mutations trigger a full re-analysis.

### Operations
- `addFiles(files: LoadedFile[])` — add or replace. If filename already exists
  in same zone, replace silently and reanalyze. If filename exists in opposite
  zone, string-zone file wins, emit `collision` warning showing which was shadowed.
- `removeFile(filename: string, zone: FileZone)` — remove from registry,
  reanalyze remaining. If removed file was providing type definitions, affected
  MessageInterfaces immediately show `structResolved: false`.
- `getAll()` — returns all non-rejected files
- `getSources()` — `.c` files from string zone only
- `getStringHeaders()` — `.h` files from string zone
- `getExternalHeaders()` — `.h` files from external zone

### Collision Rule
String-zone always wins over external-zone for same filename.
Emit warning: `"types.h loaded from both zones — string-local version takes precedence"`

---

## File Classification (src/analyzer/fileClassifier.ts)

Applied after ingestion and registry checks:

| File | Zone | Role |
|------|------|------|
| `.c` / `.cpp` | string | `source` |
| `.h` | string | `string-header` |
| `.h` | external | `external-header` |

Headers from either zone feed the type dictionary.
Only `source` files get FileAnalysis tabs.
System headers (`#include <...>`) found during parsing are ignored entirely —
they are never loaded and never referenced in output.

---

## Preprocessor Handling (src/analyzer/preprocessor.ts)

Before passing source to tree-sitter, extract `#ifdef` structure.

### Approach
- Walk the file and identify all `#ifdef` / `#ifndef` / `#else` / `#elif` /
  `#endif` blocks
- Do NOT pick a branch — collect all branches
- Tag any symbol (struct, enum, define, function) extracted from inside a
  conditional block with `conditional: true`
- If the same symbol name appears in multiple branches with different
  definitions, store all as `variants[]` and emit an `ifdef-variant` warning
- Surface in UI: conditional symbols show a "⚠ conditionally defined" badge;
  variants show all definitions with note:
  `"Multiple definitions found — active branch depends on build flags"`

### Known Limitation
Deeply nested or macro-generated `#ifdef` chains will not be fully resolved.
These are flagged as `conditional: true` and noted for manual review.

---

## Header Parsing (src/analyzer/headerParser.ts)

For each `string-header` and `external-header` file (non-rejected only):

### Circular Include Detection
Maintain `visiting: Set<string>` per parse session.
If a file attempts to include something already in `visiting`, skip and emit
`circular-include` warning.

### Extractions (via tree-sitter)
- `typedef struct { ... } Name` and `struct Name { ... }` → `CStruct`
- `typedef enum { ... } Name` and `enum Name { ... }` → `CEnum`
- `#define NAME value` → `CDefine`
- All tagged with `sourceFile` and `conditional` flag

### Symbol Conflict Detection
When adding to TypeDict:
- If name already exists and fields/values are identical → deduplicate silently
- If name already exists and fields/values differ → keep both as `variants`,
  emit `conflict` warning:
  `"struct SensorMessage defined differently in sensor_defs.h and acoustic_types.h"`

Headers do NOT generate FileAnalysis tabs. They only populate TypeDict.

---

## Source Analysis (src/analyzer/sourceAnalyzer.ts)

Uses tree-sitter-c WASM grammar for parsing. For each `source` file:

### Tree-sitter Integration
```typescript
import Parser from 'web-tree-sitter';
await Parser.init();
const parser = new Parser();
const C = await Parser.Language.load('/tree-sitter-c.wasm');
parser.setLanguage(C);
const tree = parser.parse(fileContent);
```
The `.wasm` file is bundled into the Docker image — no CDN, no network.

### Extractions
- **Functions**: name, return type, params, static vs exported
- **Extern declarations**: name, type, function vs variable
- **Local #defines**: name, value, category
- **IPC syscall patterns**: see pattern list below
- **Custom patterns**: from PatternRegistry, applied as regex over source text
- **Unknown external calls**: called but not defined in this file and not in
  the ignored stdlib set
- **Risk flags**: gets(), strcpy(), sprintf(), malloc without free,
  hardcoded hex constants, printf(), high extern count

### IPC Pattern List

Detected via tree-sitter call expression nodes + name matching:

```
socket(), connect(), bind(), listen(), accept()
send(), sendto(), recv(), recvfrom()
pipe(), mkfifo()
shmget(), shmat(), shmdt(), shmctl(), shm_open()
mq_open(), mq_send(), mq_receive()
sem_open(), semget(), sem_wait(), sem_post()
signal(), kill(), sigaction()
pthread_create(), pthread_join()
fork(), execv(), execl(), execvp(), system()
write(), read(), ioctl()
open() with string literal argument
fopen() with string literal argument
```

### Web Worker for Oversized Files
Files flagged `oversized: true` (500KB–2MB) are analyzed in a Web Worker
to avoid blocking the main thread. Progress indicator shown in the file tab.

---

## Messaging Extraction (src/analyzer/messagingExtractor.ts)

Cross-file pass. Runs after all FileAnalysis results and TypeDict are complete.
Re-runs automatically whenever files are added, removed, or patterns change.

### Step 1 — Find Message Type Constants
Scan TypeDict.defines and all FileAnalysis.defines for names matching:
`MSG_TYPE_*`, `OP_*`, `CMD_*`, `MSG_ID_*`, `PKT_TYPE_*`, `OPCODE_*`
Pattern is configurable — add to PatternRegistry if the codebase uses
a different naming convention.

### Step 2 — Resolve Struct
For each message constant, search source files for the constant being used
in the same function scope as a struct variable or pointer that is then
passed to a send/write/custom-send call.
Look up that struct name in TypeDict.
If found → `structResolved: true`, attach full CStruct.
If not found → `structResolved: false`, show warning in UI:
`"Struct not resolved — may be in an unloaded header"`

### Step 3 — Determine Direction
- Constant appears as argument to a send-side call → `producer`
- Constant appears as value compared against received data → `consumer`
- Both → `both`
- Neither determinable → `unknown`, `directionConfident: false`
  Show: `"Direction unknown — manual review needed"`

### Step 4 — Determine Transport
Identify which IpcCall in the same function scope the struct is passed through.
Record as `transport: IpcType`.

---

## Custom Pattern Registry (src/analyzer/patternRegistry.ts)

Stored in `localStorage` under key `cid_custom_patterns`.

```typescript
interface CustomPattern {
  id: string           // uuid
  name: string         // e.g. "torpedo_dispatch()"
  pattern: string      // regex e.g. "torpedo_dispatch\\s*\\("
  ipcType: IpcType
  direction: 'send' | 'recv' | 'bidirectional'
  notes: string        // e.g. "Found in dcm_bridge.c line 412, wraps write()"
}
```

### UI (PatternRegistry.tsx)
- Add / edit / delete patterns
- Export as JSON (`cid-patterns.json`)
- Import from JSON — merges, deduplicates by name
- **Re-analyze** button — triggers fresh Pass 3 + Pass 4 with updated patterns
- Pattern list shows match count across currently loaded files so analyst can
  verify the regex is hitting what they expect

---

## File Zone UI (DropZone.tsx + FileList.tsx)

### Two Zones

```
┌─────────────────────────────┐  ┌─────────────────────────────┐
│  STRING SOURCE FILES        │  │  EXTERNAL INCLUDES          │
│                             │  │                             │
│  Click to select files      │  │  Click to select files      │
│  (.c and .h)                │  │  (.h only)                  │
│                             │  │                             │
│  Drop the entire SA string  │  │  Drop shared include dir    │
│  directory here             │  │  files here                 │
└─────────────────────────────┘  └─────────────────────────────┘
```

### File Selection
- Primary interaction: `<input type="file" multiple accept=".c,.h,.cpp">` —
  click opens file browser, Ctrl+A selects all files in a directory
- Progressive enhancement: drag-and-drop also accepted where browser supports it
  (modern Firefox yes, IE no — degrades gracefully, no errors thrown)
- `webkitdirectory` NOT used — too unreliable on target browsers

### File List (below each zone)
Each loaded file shown as a row:
```
sensor_defs.h  [string-header]  [4.2 KB]  [UTF-8]        ✕
slemr_sensor.c [source]         [12.1 KB] [Latin-1 ⚠]   ✕
```
- ✕ button removes file from registry and triggers reanalysis
- ⚠ badge for encoding, oversized, or conditional symbol warnings
- Shadowed files shown in muted style with tooltip explaining collision

### Additive Behavior
- Each file selection/drop **adds to** the current set — never replaces all
- Same filename dropped again → replace that file, reanalyze
- Removing a file that provided type definitions → immediate reanalysis,
  affected MessageInterfaces show `structResolved: false`

---

## Warning Banner (WarningBanner.tsx)

Shown at top of results when any AnalysisWarning exists:

| Kind | Example Message |
|------|----------------|
| `collision` | `types.h exists in both zones — string-local version takes precedence` |
| `conflict` | `struct SensorMessage defined differently in sensor_defs.h and acoustic_types.h` |
| `encoding` | `dcm_bridge.c decoded as Latin-1 — verify special characters` |
| `oversized` | `radar_proc.c is 1.2MB — analysis may be slow` |
| `circular-include` | `Circular include detected: sensor_defs.h → acoustic_types.h → sensor_defs.h` |
| `ifdef-variant` | `SensorStatus has multiple conditional definitions — active branch depends on build flags` |

---

## Messaging Interface Card (MessagingSection.tsx)

For each MessageInterface in the current file:

```
┌──────────────────────────────────────────────────────────────┐
│  MSG_TYPE_ACOUSTIC   0x01      [PRODUCER]    via socket      │
│                                                              │
│  struct SensorMessage {                                      │
│    unsigned int    msg_type                                  │
│    unsigned int    seq_num                                   │
│    unsigned int    payload_len                               │
│    unsigned char   checksum                                  │
│    AcousticSample  sample                                    │
│  }                  defined in: acoustic_types.h             │
│                                                              │
│  referenced in: slemr_sensor.c                               │
└──────────────────────────────────────────────────────────────┘

⚠ Struct not resolved — may be in an unloaded header
⚠ Direction unknown — manual review needed
⚠ Conditionally defined — active branch depends on build flags
```

Warnings appear inline below the card only when applicable.

---

## Summary Bar

Across all loaded source files:

`FILES  |  FUNCTIONS  |  MSG INTERFACES  |  IPC CALLS  |  EXTERNS  |  UNKNOWNS  |  RISKS`

---

## Export

### EXPORT TXT
Flat text report per source file. Includes:
- All messaging interface cards (resolved and unresolved)
- Functions, IPC calls, structs, externs, defines
- Risk flags
- Unknown external calls
- All analysis warnings

### EXPORT PATTERNS
Exports custom pattern registry as `cid-patterns.json`.
Can be imported on another analyst's instance to share learned patterns
across strings without retransfer of the container.

---

## Docker / Airgap Deployment

### Strategy
The container ships with full source code and Node.js so small changes can be
made and rebuilt inside the container without a retransfer. nginx serves the
production build. A dev server is also available inside the container.

### Dockerfile

```dockerfile
FROM node:20-alpine

# Install nginx
RUN apk add --no-cache nginx

WORKDIR /app

# Copy source
COPY . .

# Install dependencies and build at image build time
RUN npm ci
RUN npm run build

# Copy build output to nginx root
RUN cp -r dist/* /usr/share/nginx/html/

# Copy nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose both prod (80) and dev (3000) ports
EXPOSE 80 3000

# Start nginx by default (prod mode)
CMD ["nginx", "-g", "daemon off;"]
```

### nginx.conf

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

### Airgap Transfer Procedure

```bash
# On internet-connected machine:
docker build -t c-interface-discovery:1.0 .
docker save c-interface-discovery:1.0 | gzip > cid-v1.0.tar.gz
# Transfer cid-v1.0.tar.gz via approved removable media

# On airgapped machine:
docker load < cid-v1.0.tar.gz

# Run in production mode (serves pre-built app):
docker run -d -p 8080:80 --name cid c-interface-discovery:1.0

# Run in dev mode with source mounted (edit and rebuild without retransfer):
docker run -d -p 3000:3000 \
  -v /path/to/cid-source:/app \
  --name cid-dev c-interface-discovery:1.0 \
  sh -c "cd /app && npm run dev -- --host 0.0.0.0 --port 3000"

# Access prod at:  http://<host-ip>:8080
# Access dev at:   http://<host-ip>:3000
```

### Rebuilding Inside the Container (after source edits)

```bash
docker exec -it cid-dev sh
cd /app
# make edits to source files
npm run build
cp -r dist/* /usr/share/nginx/html/
exit
# Changes live immediately on port 8080
```

---

## Known Limitations

Document these for users in the tool's help panel:

- **Custom messaging wrappers** not detected until manually added to pattern registry
- **Serialization layers** (XDR, custom pack/unpack) will obscure message shapes — struct shown may be the wire format wrapper, not the semantic message
- **Macro-expanded code** partially defeats struct/enum detection — tree-sitter sees the raw macro call, not the expansion
- **Direction inference** is heuristic — confident flag shown, manual review recommended for `unknown` cases
- **#ifdef branches** all parsed but active branch unknown without build flags — conditional symbols flagged explicitly
- **Very large files** (500KB–2MB) analyzed but may be slow — files >2MB skipped entirely
- **Struct-to-message correlation** relies on same-function scope heuristic — may miss correlations across function call chains

---

## Phase Roadmap

| Phase | Scope                                                        | Status  |
|-------|--------------------------------------------------------------|---------|
| 1     | File ingestion, encoding, classification, registry, warnings | Planned |
| 2     | Tree-sitter integration, header parsing, type dictionary     | Planned |
| 3     | Source analysis (functions, IPC, externs, risks, unknowns)   | Planned |
| 4     | Messaging extraction (enums + structs + transport + direction)| Planned |
| 5     | Custom pattern registry + re-analysis trigger                | Planned |
| 6     | Cross-file dependency resolution                             | Planned |
| 7     | Export (TXT + patterns JSON) + Docker packaging              | Planned |
