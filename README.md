# C Interface Discovery

A static analysis web application for mapping messaging interfaces in legacy C submarine combat system codebases. Runs 100% in the browser — zero network calls, zero backend. Deployable as a Docker container for airgapped environments.

## What it does

### Application-level view (multi-app)

Load files for multiple named applications and the tool will:

- Display a **cross-application graph** — nodes are applications, edges are message flows between them
- Detect **transit/broker apps** automatically: an app that both produces and consumes the same message constant is treated as a router; edges route *through* it rather than creating false direct connections between endpoints
- Show **named external systems**: custom patterns marked "always draw to external node" produce their own named node (e.g. `? bummer`) shared across all apps that reference the same external system
- Click any edge to see the full **MessageInterface detail panel** — struct, value, direction, transport, and per-file roles for every message on that edge
- Click any app node to **drill down** into the per-file analysis view for that application

### Per-application (file-level) view

Load `.c` and `.h` files from a single string (SA, TA, fire control, etc.) and the tool will:

- Extract all **message type constants** (`MSG_TYPE_*`, `CMD_*`, `OP_*`, etc.) and correlate them with structs and IPC transport
- Detect **IPC patterns**: sockets, pipes, shared memory, message queues, semaphores, signals, threads, fork/exec, file I/O, ioctl
- Inventory **functions**, **extern declarations**, **structs**, **enums**, and **defines**
- Flag **risks**: `gets()`, `strcpy()`, `sprintf()`, memory leaks, hardcoded hex constants
- Warn on **file collisions**, **struct conflicts**, **encoding issues**, and **conditional definitions**
- Support **custom call patterns** (regex-based, localStorage-backed, exportable as JSON)
- Export a flat **TXT report** or **patterns JSON**

No C compiler required. Analysis is TypeScript string parsing + [Tree-sitter WASM](https://github.com/tree-sitter/tree-sitter) for accurate C syntax parsing.

## Tech stack

- React 18 + TypeScript (strict)
- Vite
- Tree-sitter WASM (tree-sitter-c grammar, runs fully in-browser)
- React Flow (graph visualization)
- Dagre (automatic graph layout)
- Tailwind CSS
- Docker + nginx for airgapped deployment

## Local development

```bash
npm install       # installs deps and copies WASM files to public/
npm run dev       # dev server at http://localhost:5173
npm test          # run unit tests
npm run build     # production build → dist/
```

## Airgap deployment

### Build and export the image

```bash
# On an internet-connected machine:
docker build -t c-interface-discovery:1.0 .
docker save c-interface-discovery:1.0 | gzip > cid-v1.0.tar.gz
# Transfer cid-v1.0.tar.gz via approved removable media
```

### Load and run on airgapped machine

```bash
docker load < cid-v1.0.tar.gz

# Production mode (pre-built app):
docker run -d -p 8080:80 --name cid c-interface-discovery:1.0
# Access at: http://<host-ip>:8080

# Dev mode with source mounted (edit and rebuild without retransfer):
docker run -d -p 3000:3000 \
  -v /path/to/cid-source:/app \
  --name cid-dev c-interface-discovery:1.0 \
  sh -c "cd /app && npm run dev -- --host 0.0.0.0 --port 3000"
# Access at: http://<host-ip>:3000
```

### Rebuild inside the container after source edits

```bash
docker exec -it cid-dev sh
cd /app
# make edits to source files
npm run build
cp -r dist/* /usr/share/nginx/html/
exit
# Changes live immediately on port 8080
```

## Usage

### Multi-application workflow

1. The tool opens with one named application zone — rename it, then **drop string files** (`.c` and `.h`) into it
2. Click **+ Add Application** to add more applications; drop their files into each zone
3. Drop **external includes** (`.h` only) into the shared external headers zone — these are available to all applications
4. The **application graph** renders automatically as files are loaded; edges represent cross-app message flows
5. Click an **edge** to inspect the full message interface detail for that connection
6. Click an **app node** to drill into per-file analysis for that application
7. Add **custom patterns** for project-specific send/recv wrappers; patterns with "always draw to external node" create named external system nodes visible in both the file-level and application-level graphs

### Single-application / per-file workflow

1. **Drop string files** (`.c` and `.h`) into the application zone
2. **Drop external includes** (`.h` only) into the external headers zone
3. Analysis runs automatically; results appear in tabs per source file
4. The **Messaging Interfaces** section is the primary deliverable — one card per detected message type
5. Add **custom patterns** for project-specific send/recv wrappers not detected automatically
6. Use **Re-analyze** after adding patterns to refresh results
7. **Export TXT** for a flat report; **Export Patterns** to share learned patterns across analyst instances

## Test fixtures

`test-fixtures/` contains three synthetic applications for end-to-end testing of the multi-app flow:

| Directory | Description |
|---|---|
| `synthetic-string/` | Acoustic sensor array — produces `MSG_TYPE_SOLUTION`, consumes `MSG_TYPE_COMMAND` |
| `synthetic-wcs/` | Weapons Control System — consumes `MSG_TYPE_SOLUTION`, produces `MSG_TYPE_COMMAND` |
| `synthetic-broker/` | Message broker — receives from publishers, routes to subscribers; detected automatically as a transit app |

Loading all three demonstrates transit-app detection: the broker routes both message types, and the graph shows sensor array → broker → WCS and WCS → broker → sensor array with no false direct connections.

## Known limitations

- Custom messaging wrappers not detected until manually added to the pattern registry
- Serialization layers (XDR, custom pack/unpack) will obscure message shapes
- Macro-expanded code partially defeats struct/enum detection
- Direction inference is heuristic — `unknown` cases require manual review
- `#ifdef` branches all parsed, but active branch unknown without build flags
- Files >2MB are rejected; 500KB–2MB are flagged as oversized
- Struct-to-message correlation relies on same-function scope heuristic
