# C Interface Discovery

A static analysis web application for mapping messaging interfaces in legacy C submarine combat system codebases. Runs entirely in the browser — zero internet access, zero backend. Deployable as a Docker container for airgapped environments. An **optional** LLM assistant can connect to a self-hosted inference server on the same isolated network; with it disabled (the default) nothing makes a network request.

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
docker build -t c-interface-discovery:2.1.0 .
docker save c-interface-discovery:2.1.0 | gzip > cid-v2.1.0.tar.gz
# Transfer cid-v2.1.0.tar.gz via approved removable media
```

### Load and run on airgapped machine

```bash
docker load < cid-v2.1.0.tar.gz

# Production mode (pre-built app):
docker run -d -p 8080:80 --name cid c-interface-discovery:2.1.0
# Access at: http://<host-ip>:8080

# Dev mode with source mounted (edit and rebuild without retransfer):
docker run -d -p 3000:3000 \
  -v /path/to/cid-source:/app \
  --name cid-dev c-interface-discovery:2.1.0 \
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

`test-fixtures/` has three small apps for the original multi-app flow, plus a larger combat-system suite.

| Directory | Description |
|---|---|
| `synthetic-array/` | Acoustic sensor array — produces `MSG_TYPE_SOLUTION`, consumes `MSG_TYPE_COMMAND` |
| `synthetic-wcs/` | Weapons Control System — consumes `MSG_TYPE_SOLUTION`, produces `MSG_TYPE_COMMAND` |
| `synthetic-broker/` | Message broker — transit app for those two message types |
| `synthetic-titan/` | Custom `titan_send_message` / `titan_recv_message` bus (needs `cid-config.json`) |
| `synthetic-cic/` | Four-app combat system with 6-layer nested payloads, a fake `usr/include`, mixed IPC, and a transit CIC |

The original three: load array + WCS + broker. The graph should show sensor array → broker → WCS and the reverse, with no direct array–WCS edge.

`synthetic-cic/` is the stress fixture. Import `test-fixtures/cid-config.json` first, drop `synthetic-cic/common/` and `synthetic-cic/usr/include/` into External Includes, then one folder per application:

| App name | Folder | Role |
|---|---|---|
| Sonar | `synthetic-cic/sonar/` | Produces `MSG_TYPE_CONTACT` and `MSG_TYPE_TRACK` |
| Nav | `synthetic-cic/nav/` | Produces `MSG_TYPE_OWN_SHIP` |
| CIC | `synthetic-cic/cic/` | Transit for `MSG_TYPE_TRACK`; consumes contact / own-ship / engage |
| Fire Control | `synthetic-cic/firecontrol/` | Consumes `MSG_TYPE_TRACK`, produces `MSG_TYPE_ENGAGE` and unmatched `MSG_TYPE_WEAPON_ORD` |

Expected graph: Sonar → CIC → Fire Control for tracks, Sonar → CIC for contacts, Nav → CIC for own-ship, Fire Control → CIC for engage.

Contact payloads nest six app structs (`ContactMsg` → `FusedContact` → `TrackKinematics` → `MotionState` → `DepthFix` → `GeoCoord` → `CicTime`) and then system types from the fake include tree (`timeval` / `__time_t` in `sys/time.h` and `bits/types.h`, `sockaddr_in` / `in_addr` in `netinet/in.h`).

## Optional LLM assistant

Disabled by default. When enabled, the app can query a **self-hosted Gemma 4 model served by
vLLM** on the same airgapped network — no internet access is involved. Analysis never depends
on it: with the feature off, or the endpoint unreachable, every existing code path behaves
exactly as before.

### Run the app with the LLM proxy

```bash
docker run -d -p 8080:80 \
  -e LLM_UPSTREAM=vllm-host:8000 \
  --name cid c-interface-discovery:2.1.0
```

`LLM_UPSTREAM` is optional. When it is set, nginx proxies `/llm/` to that host; when it is
unset the proxy block is stripped and `/llm/` returns 404, which the app reads as "no LLM
available". The proxy keeps the browser same-origin, which matters because the
`Cross-Origin-Embedder-Policy: require-corp` header that tree-sitter WASM needs would otherwise
force CORS *and* CORP headers out of vLLM.

`docker-compose.yml` runs app + vLLM together.

### Serving Gemma 4 for this app

```bash
vllm serve google/gemma-4-26B-A4B-it \
  --enable-auto-tool-choice \
  --tool-call-parser gemma4 \
  --reasoning-parser gemma4 \
  --chat-template examples/tool_chat_template_gemma4.jinja
```

The chat template is not optional — the stock HuggingFace Gemma 4 template does not emit the
tool-definition encoding the `gemma4` parser expects.

### Asking questions

With the assistant enabled, an **✦ Ask** button appears in the header. The panel scopes to one
application, all of them, or a single message, and answers are grounded in analyzer output:

- The prompt carries a **tiered digest** of the analysis — message table with composition and
  both target sizes, struct stubs, unresolved items, unmatched calls. Struct *bodies* are not in
  the prompt; they arrive through a tool call when a question needs them.
- The model reaches the rest through **10 read-only tools** (`getStructLayout`,
  `getStructGraph`, `findUsages`, `getPayloadResolutions`, `getSourceLines`, …). Every one is
  deterministic TypeScript over the in-memory analysis — the model never computes an offset.
- The **tool-call trace** shows exactly which analyzer facts an answer was built from, and
  **what was sent?** expands the full digest.
- Citations like `router.c:142` are clickable and drill into the file view.
- When the digest cannot fit, omissions are recorded, shown in the UI, and stated in the prompt
  so the model knows to use a tool rather than assume something does not exist.

### Suggesting custom patterns

The registry's blind spot is project-specific messaging wrappers. With the assistant on,
**✦ Suggest from N calls** appears above the pattern registry: it hands the model the
frequency-ranked unclassified calls with real call sites, and asks which are transport wrappers.

Nothing the model proposes is displayed until it has been **compiled and run against the loaded
source**. A proposal that is not a valid regex, matches nothing, matches the empty string, or
duplicates an existing entry is discarded — you see the match count and real matching lines
before deciding. Accept routes through the normal registry and triggers a re-analysis.

The model writes a hypothesis; the analyzer decides whether it survives.

### Verify after transfer

Open **LLM Assistant → Run diagnostics**. It probes each capability the assistant needs —
reachability, non-streaming completion, SSE streaming, tool calling, structured output,
reasoning split — and prints what failed and what to change. **↓ Save report** writes a text
file you can carry off the host. This is the acceptance test for a new deployment.

> Leave **Stream tool-call turns** off. vLLM's `gemma4` tool parser has open streaming defects
> ([#42696](https://github.com/vllm-project/vllm/issues/42696),
> [#44522](https://github.com/vllm-project/vllm/issues/44522)) reported at 21–35% success
> streaming versus 100% non-streaming. The app streams the final answer with `tool_choice:
> none`, which never exercises that path.

## Design docs

- [`docs/payload-resolution-patterns.md`](docs/payload-resolution-patterns.md) — how the payload resolver infers struct types at send sites
- [`docs/llm-integration-plan.md`](docs/llm-integration-plan.md) — **proposed** integration for querying analysis output with a self-hosted Gemma 4 / vLLM model (not implemented)

## Known limitations

- Custom messaging wrappers not detected until manually added to the pattern registry
- Serialization layers (XDR, custom pack/unpack) will obscure message shapes
- Macro-expanded code partially defeats struct/enum detection
- Direction inference is heuristic — `unknown` cases require manual review
- `#ifdef` branches all parsed, but active branch unknown without build flags
- Files >2MB are rejected; 500KB–2MB are flagged as oversized
- Struct-to-message correlation relies on same-function scope heuristic
