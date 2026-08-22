# LLM Integration Plan — Asking Questions About Analysis Output

Status: **proposed**, not implemented.
Target backend: **Gemma 4 26B A4B**, served by vLLM on the airgapped network.

The goal: after the analyzer has produced a `StringAnalysis` for each application, an analyst
can ask natural-language questions about it — *"which apps consume `MSG_TYPE_TRACK` and what
struct do they expect?"*, *"why is the direction on `MSG_TYPE_WEAPON_ORD` unknown?"*,
*"what would a custom pattern for `titan_send_message` look like?"* — and get answers grounded
in the analyzer's own output rather than in the model's guesses.

---

## 1. Model assumptions

Gemma 4 26B A4B, per Google's model card:

| Property | Value | Consequence for this design |
|---|---|---|
| Architecture | MoE, 25.2B total / ~3.8B active per token | Cheap enough to serve per-site; fast decode |
| Context window | 262,144 tokens (256K) | Whole-analysis context is viable — but see §4 on why we still don't stuff it |
| Max output | 32,768 tokens | Never the binding constraint here |
| Function calling | **Native** | Standard OpenAI `tools` / `tool_calls`; no prompted-JSON workaround (§5) |
| Thinking | Configurable reasoning mode | Separate `reasoning_content` field; affects UI and token accounting (§5) |
| License | Apache 2.0 | No redistribution friction for the airgap transfer |

**Do not hardcode the context length.** Deployments vary — Cloudflare Workers AI serves this
model at 131,072 despite the 256K card figure. `GET /v1/models` reports the served
`max_model_len`; read it at health-check time and derive the digest budget from it (§4).

Since the endpoint already works with OpenCode, the tool-calling path is configured and
proven. The OpenCode provider config is the fastest source of truth for base URL and exact
model ID — lift them rather than rediscovering them.

---

## 2. Deployment topology

Two containers on the airgapped host. The app container reverse-proxies the model.

```
browser ──http──> nginx (app container :80)
                    ├── /            → static SPA
                    └── /llm/…       → proxy_pass http://vllm:8000/…
                                        (vLLM OpenAI-compatible server, Gemma 4 26B A4B)
```

**Why proxy instead of calling vLLM directly from the browser:**

1. `nginx.conf` sets `Cross-Origin-Embedder-Policy: require-corp` (needed for tree-sitter
   WASM). A cross-origin `fetch` to vLLM then requires correct CORS *and* CORP headers from
   vLLM. Same-origin sidesteps all of it.
2. No CORS config needed on the vLLM side.
3. No mixed-content problem if the app is ever served over HTTPS.
4. The vLLM host/port becomes a *deployment* concern (one env var at `docker run` time), not a
   thing every analyst pastes into a settings box on every workstation.

Settings-box entry of a raw endpoint URL stays supported as an escape hatch for the dev-mode
workflow, but the proxy is the documented path.

### vLLM serve flags

Tool calling on Gemma 4 needs the parser *and* the vendored chat template — the stock
HuggingFace template does not emit the tool-definition encoding the parser expects:

```bash
vllm serve google/gemma-4-26B-A4B-it \
  --enable-auto-tool-choice \
  --tool-call-parser gemma4 \
  --reasoning-parser gemma4 \
  --chat-template examples/tool_chat_template_gemma4.jinja
```

Gemma 4 serializes tool calls in a custom non-JSON format
(`<|tool_call>call:fn{key:<|"|>value<|"|>}<tool_call|>`); the `gemma4` parser converts that to
standard OpenAI `tool_calls`. `--reasoning-parser gemma4` splits thinking into
`reasoning_content` so it doesn't land in `message.content`. If your existing OpenCode setup
already runs, these are already in place.

### nginx addition

```nginx
    # Optional LLM proxy. LLM_UPSTREAM is substituted at container start;
    # when unset the location is omitted and the feature self-disables.
    location /llm/ {
        proxy_pass http://${LLM_UPSTREAM}/;
        proxy_http_version 1.1;
        proxy_set_header Connection "";

        # Token streaming: nginx must not buffer the SSE body.
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding on;

        # Long generations on a busy GPU.
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
```

`nginx.conf` becomes `nginx.conf.template`, rendered with `envsubst` by a small entrypoint
script so `docker run -e LLM_UPSTREAM=vllm:8000` is all that is required. With no
`LLM_UPSTREAM`, the entrypoint emits the current config verbatim and `/llm/` 404s — which the
health check reads as "LLM unavailable", and the UI hides itself.

A `docker-compose.yml` is added showing app + vLLM together. The single-image `docker run`
path in the README keeps working unchanged.

---

## 3. Provider layer — `src/llm/`

New module, no dependencies on React, unit-testable without a server.

```
src/llm/
  client.ts        # fetch wrapper: chat(), chatStream(), listModels(), health()
  config.ts        # LlmConfig type, localStorage persistence, defaults
  digest.ts        # StringAnalysis → compact grounded context  (§4)
  tools.ts         # OpenAI tool definitions + local executors  (§5)
  prompts.ts       # system prompts + task templates
  schemas.ts       # JSON Schemas for tool params and structured responses
  __tests__/
```

### `LlmConfig`

```ts
export interface LlmConfig {
  enabled: boolean;
  baseUrl: string;        // default '/llm' (the nginx proxy)
  model: string;          // populated from /v1/models
  apiKey?: string;        // vLLM --api-key, if the site sets one
  temperature: number;    // default 0.2 — this is an analysis tool, not a writing tool
  maxTokens: number;      // response cap, default 4000
  thinking: 'off' | 'auto';       // default 'auto'; see §5
  digestBudgetTokens: number;     // default: min(32000, maxModelLen * 0.25) — see §4
  includeSourceSnippets: boolean; // default true
  streamToolTurns: boolean;       // default FALSE — see §5, this one matters
}
```

Persisted in `localStorage` under `cid_llm_config`, alongside the existing pattern registries.
Deliberately **not** in the exportable `cid-config.json`, which is shared between analysts and
should not carry a per-workstation endpoint or an API key.

### Health check

On mount (and on settings save): `GET {baseUrl}/v1/models`. Success populates the model
dropdown, records `max_model_len`, and flips the UI on. Failure (404, connection refused,
timeout) leaves every LLM affordance hidden and shows a single unobtrusive line in settings.
No retries, no console noise, no impact on analysis.

---

## 4. Context management

This is the core of the design, so it's worth being precise about it. A real string source is
far larger than any context window — but the raw source is never what goes into the prompt.

### 4.1 The analyzer is already the compression step

`StringAnalysis` is an *index*, not a copy. A million lines of C is ~9.1M tokens of source; the
message table, cross-app edges, unresolved items and struct stubs derived from it are ~122K.
The analyzer throws away the 98.7% that is control flow, arithmetic, logging and comments, and
keeps the interface surface — which is exactly what analysts ask questions about.

Measured against the digest row formats below (`chars/3.5`, pessimistic for C identifiers):

| Scenario | SLOC | Raw source | Digest (§4.3) | Ratio |
|---|---:|---:|---:|---:|
| `synthetic-cic/` fixture | 1,537 | 14K | 0.8K | 17× |
| Small string | 25,000 | 229K | 5.3K | 43× |
| Medium string | 120,000 | 1.1M | 20K | 56× |
| Large string | 400,000 | 3.7M | 53K | 69× |
| Very large string | 1,000,000 | 9.1M | 122K | 75× |

Compression *improves* with size, because interface surface grows sublinearly with
implementation volume. A million-line string still fits a 256K window with room for a
conversation. This is the whole reason the approach works.

### 4.2 Four mechanisms, applied in order

**1. Scope.** The panel defaults to *this application*, not all of them. An analyst asking
about fire control does not need sonar's internals in context. Divides by the app count for
free. Opening the panel from a message card or graph edge narrows further, to that one
interface and its neighbours.

**2. Index in context, bodies on demand.** This is the load-bearing decision. Measurement says
struct field lists are ~63% of a naive digest — 173K of a 275K total at million-line scale —
while the message table that analysts actually care about is only 35K. So struct *bodies* do
not go inline. Each struct referenced by a message interface gets a one-line stub:

```
ContactMsg (72B, 12 fields, cic_protocol.h)
```

The full layout arrives through `getStructLayout` / `getStructGraph` when a question needs it.
That single change takes the million-line case from 275K (does not fit) to 122K (fits, with
134K to spare). The model knows the struct *exists*, what it costs, and where it lives — enough
to decide whether to look it up.

**3. Tools for depth.** A question touches a handful of entities, not thousands:

| Question | Tool calls | Tokens pulled |
|---|---|---:|
| *"What struct does `MSG_TYPE_CONTACT` carry?"* | `getMessageInterface`, `getStructGraph(depth 6)` | ~2,100 |
| *"Why is `MSG_TYPE_WEAPON_ORD` direction unknown?"* | `getMessageInterface`, `findUsages`, `getSourceLines`×3 | ~1,000 |
| *"Suggest a pattern for `link11_write`"* | `getUnknownCalls`, `getSourceLines`×5 | ~1,400 |

One to two thousand tokens of *exactly the right facts*, versus a hundred thousand of
everything. This is also why precision beats coverage: a struct layout fetched by name is read
correctly far more reliably than the same layout buried at position 180K in a stuffed prompt.

**4. Degrade, don't truncate silently.** When even the index exceeds budget, drop tiers in
priority order and *record every omission* in `omitted[]`, which the UI renders. The model is
told in-prompt what was withheld and that tools can reach it. At the extreme — a string whose
message table alone exceeds the window — the digest falls back to tier 1 plus a
`searchMessages(pattern)` tool, and the model queries the index instead of reading it.

The failure mode this avoids is the dangerous one: a model answering confidently from a context
it doesn't know was cut.

### 4.3 The tiers

Fill the budget in priority order:

| Tier | Content | ~Cost/entity | Notes |
|---|---|---:|---|
| 1 | App inventory: names, file counts, per-app produced/consumed constants | — | Always. Tiny. |
| 2 | `MessageInterface` table: constant, value, struct name, direction + confidence, transport, `definedIn`, producer/consumer files | 39 tok | Always. The primary deliverable. |
| 3 | Cross-app edges from `buildAppGraph`, incl. transit/broker routing | 13 tok | Always. Small. |
| 4 | Struct **stubs** for structs reachable from a message interface | 11 tok | Bodies via tools |
| 5 | Unresolved: `structResolved: false`, `direction: 'unknown'`, `incomplete`, low-confidence `payloadResolutions`, `headerGenBundle.review` | 27 tok | Where the questions cluster |
| 6 | `unknownCalls` / unmatched IPC, deduped and frequency-ranked | 23 tok | Feeds §7 |
| 7 | Risk flags, defines, enums, full function inventories | 24 tok | First dropped; tool-reachable |

Budget default: `min(32_000, max_model_len * 0.25)`. The quarter-window cap is deliberate —
it leaves room for tool results and a multi-turn conversation, and keeps the prompt in the
range where recall stays sharp.

### 4.4 Why not just stuff 256K

Three reasons, beyond the fact that it stops working above ~2M SLOC:

1. **Mid-context recall loss.** A byte offset at position 180K is materially less reliably
   retrieved than the same fact at 20K. For this tool a *wrong* offset is worse than "I don't
   know" — it ends up in a message spec.
2. **Prefix cache economics.** On a shared GPU, a stable 20K digest prefix is cached and reused
   across every turn of a conversation; only the question and tool results re-prefill. A 200K
   prompt re-prefills constantly and evicts other analysts' blocks.
3. **It hides the boundary.** With tiering, `omitted[]` states exactly what's missing. With
   stuffing, you find out when an answer is quietly wrong.

### 4.5 Implementation

```ts
export interface DigestOptions {
  budgetTokens: number;
  scope: { kind: 'app'; appId: string } | { kind: 'all' } | { kind: 'message'; constant: string };
  includeSourceSnippets: boolean;
  redact?: (s: string) => string;
}

export interface AnalysisDigest {
  text: string;              // the markdown block that goes in the prompt
  estimatedTokens: number;
  omitted: DigestOmission[]; // what was dropped and why — rendered in the UI
}
```

**Determinism matters here.** Given the same `StringAnalysis` and options, `buildDigest` returns
byte-identical output — stable sort on every collection. Two payoffs: it is snapshot-testable
against `test-fixtures/synthetic-cic/`, and it makes vLLM prefix caching actually hit, since the
digest prefix is bit-identical across every turn.

**Token estimation** uses `chars/3.5`, deliberately pessimistic — C identifiers are long and
tokenize badly. It must never under-estimate; exactness is not required.

`redact` is an optional hook applied to every string before it enters the prompt — one place to
implement identifier scrubbing if a deployment ever wants it.

## 5. Tool calling — and the streaming caveat that shapes it

Gemma 4 has native function calling and vLLM has a `gemma4` tool parser, so this is the
standard OpenAI loop: send `tools`, get `tool_calls`, execute locally, append `role: "tool"`
messages, repeat. No prompted-JSON workaround.

### ⚠ The one thing to get right: do not stream tool-call turns

vLLM's `gemma4` tool parser has a cluster of **open streaming-mode defects**:

| Issue | Symptom |
|---|---|
| [#42696](https://github.com/vllm-project/vllm/issues/42696) | Missing `id`/`type` on continuation chunks → strict-client validation failures; multi-tool deltas mis-attributed across tool indices under concurrency. Reported at **21–35% success streaming vs 100% non-streaming.** |
| [#44522](https://github.com/vllm-project/vllm/issues/44522) | Raw `<\|"\|>` delimiter tokens leak into the streamed response instead of being parsed into `tool_calls` |
| [#39089](https://github.com/vllm-project/vllm/issues/39089) | Boolean values corrupted in streamed tool-call arguments |
| [#39392](https://github.com/vllm-project/vllm/issues/39392) | `<pad>` tokens emitted under concurrent requests |

Non-streaming uses a single regex pass with no incremental state and is reported at 100%
success. The maintainer-suggested workaround is simply: don't stream tool calls.

Note #42696 was filed *against OpenCode specifically* — its `@ai-sdk` provider does strict Zod
validation on every chunk. If OpenCode ever gets flaky against this endpoint under load, that
is the cause, and the same fix applies there.

**So the request strategy is split:**

```
Turn 1..N   (tool calls)   stream: false,  tools: [...]        ← reliable, and short anyway
Turn final  (prose answer) stream: true,   tool_choice: 'none' ← streaming parser never runs
```

Tool-call turns produce a few dozen tokens, so losing streaming there costs almost nothing
perceptually — the UI shows *"Looking up `FusedContact` layout…"* per call, which is better
feedback than watching JSON arrive character by character. The final answer, which is the long
part, still streams. Because the final turn carries `tool_choice: 'none'`, the buggy streaming
tool path is never exercised.

`streamToolTurns` exists as a config flag so this can be flipped on once the upstream fixes
land, without a code change.

### Thinking mode

`--reasoning-parser gemma4` puts thinking in `reasoning_content`, separate from `content`.

- Render it in a collapsed "reasoning" disclosure, never as the answer.
- Thinking tokens count against `max_tokens` — hence the 4000 default rather than 1500.
- `thinking: 'off'` for the pattern-suggestion flow (§7), which is a structured-output task
  where reasoning adds latency without much benefit. `'auto'` for analytical questions, where
  multi-hop reasoning over message flows is exactly what you want.

### Tool surface — `tools.ts`

Every one of these is a pure function over `StringAnalysis` and already has an implementation
or near-equivalent in the codebase. The model decides *what* to look up; the lookup itself is
deterministic TypeScript with no hallucination surface.

| Tool | Backed by |
|---|---|
| `getMessageInterface(constant)` | `analysis.messageInterfaces` |
| `getStructLayout(name)` | `structCatalog.layouts` — real byte offsets, padding, size |
| `getStructGraph(name, depth)` | recursive walk; the CIC fixture nests six levels |
| `findUsages(symbol)` | `utils/findReferences.ts` + `MessageInterface.usedIn` |
| `getPayloadResolutions(file?, constant?)` | `analysis.payloadResolutions` |
| `getSourceLines(file, from, to)` | `LoadedFile.content` |
| `getUnknownCalls(app)` | `FileAnalysis.unknownCalls` |
| `getCrossAppEdges(constant?)` | `utils/buildAppGraph.ts` |
| `getHeaderGenReview(app)` | `headerGenBundle.review` |
| `getMessageComposition(constant, depth)` | derived projection — what a message is composed of (§10) |
| `getPaddingMap(struct, target)` | `structLayoutEngine` — located padding gaps (§9) |
| `getLayoutDiff(struct)` | 32-bit vs 64-bit size/offset diff (§9.4) |
| `getStructRoles(app)` | `structRoleAnalyzer` — wire roots, envelopes, shared blocks (§8) |
| `searchMessages(pattern)` | `analysis.messageInterfaces` — the fallback when even the message table is withheld (§4.2) |

Guardrails: max 6 tool-call rounds per question, max 10 calls per round, per-tool result size
caps, and unknown tool names return a structured error the model can recover from rather than
throwing. Results carry provenance (`file`, `line`, `sourceFile`) and the system prompt
requires citing it.

---

## 6. UI

A right-hand **Ask** panel, toggled from the header, available in both IPC and Interface mode.
No new routes, no change to the existing layout when it is closed.

- **Scope selector**: *This application* / *All applications* / *This message*. Drives
  `DigestOptions.scope`. Opening the panel from an app-graph edge or a message card pre-scopes
  it to that message.
- **Tool-call trace** — each call rendered as a line (*"→ getStructLayout(FusedContact)"*) with
  its result expandable. This is the transparency mechanism: an analyst can see exactly which
  analyzer facts the answer was built from, and spot when the model looked up the wrong thing.
- **Reasoning disclosure** — collapsed by default.
- **Streaming answer** with a cancel button (`AbortController` on every request).
- **Citations** as chips — `array_pub.c:142`, `struct ContactMsg` — wired to the existing
  `setActiveFile` / drill-down handlers. This is what makes the panel part of the tool rather
  than a chatbot bolted onto it.
- **Context inspector** — "N tokens of context · what's included?" expanding to the exact digest
  text and the `omitted[]` list. Primarily a debugging and token-spend aid: when an answer is
  wrong, the first question is always whether the fact was in context at all.
- **Conversation** in React state only, not persisted to IndexedDB — the session store is for
  files.
- **Suggested questions** seeded from the analysis: if `messageInterfaces` has entries with
  `structResolved: false`, offer *"Why couldn't these 3 message structs be resolved?"*

---

## 7. The high-value case: LLM proposes, analyzer verifies

The README's first known limitation is:

> Custom messaging wrappers not detected until manually added to the pattern registry

Today an analyst reads `unknownCalls`, recognises `titan_send_message(handle, MSG_ID, &buf,
len)` as a transport wrapper, and hand-writes a regex plus arg indices in the pattern registry.
That is exactly the kind of pattern-recognition-over-unfamiliar-code task a model is good at,
*and* — critically — the result is **machine-checkable**.

Flow:

1. Model receives the ranked `unknownCalls` list plus representative call sites fetched via
   `getSourceLines`, with `response_format: { type: 'json_schema' }` pinned to the
   `CustomPattern` shape: `pattern`, `ipcType`, `direction`, `msgArgIndex`, `payloadArgIndex`,
   `lengthArgIndex`, `msgConstantPattern`, `notes`. Gemma 4 supports structured output
   natively. `thinking: 'off'` here.
2. The app **compiles the regex and runs it against the loaded corpus** before showing
   anything — reusing `refreshMatchCounts()`, which already exists in `App.tsx`.
3. The analyst sees: proposed pattern, match count, and up to 10 real matching lines. An
   invalid regex or zero matches is rejected silently and never displayed.
4. **Accept** routes through the existing `handleAddPattern` → `handleReanalyze` path. Nothing
   bypasses the normal registry.

The model never touches analysis output directly. It writes a *hypothesis*; the deterministic
analyzer is the judge. Same pattern applies to `MsgStructPattern` suggestions, where
`handleDetectMsgStructs()` already does the heuristic half of the job.

This is the part of the integration worth building even if the chat panel never gets used.

> Note on `response_format`: use it rather than the `guided_*` extra-body fields, which were
> deprecated and **removed in vLLM v0.12.0** in favour of `structured_outputs: { json: … }`.
> `response_format` is the OpenAI-standard spelling and is stable across versions.

---

## 8. Worked example: "what are my top-level structures?"

A real analyst question, and a useful test of where the boundary sits:

> *"We know what structs this process uses, but messages are sometimes a combination of
> individual blocks into a message. What are my top-level structures?"*

**This is not an LLM question.** It is a graph computation over data the analyzer already has,
and it should be answered deterministically — then narrated by the model. Getting this
backwards (asking Gemma to eyeball the struct list) produces plausible, unverifiable answers
about byte-level wire formats, which is the one thing this tool must not do.

### 8.1 The computation — `structRoleAnalyzer.ts`

Build a **containment graph** from `structCatalog`: for each struct, for each field, resolve
the field type through `canonicalName()` (already in `headerGenBundle.ts` — strips
`const`/`*`/`[]`, follows typedef aliases up to 4 hops). A by-value field creates an edge
parent → child. Pointer fields do *not* create containment edges, but are recorded — a pointer
in a wire struct means it is not flat-serializable, which is a finding in itself.

Then classify each struct by **in-degree** (how many distinct structs embed it) crossed with
**binding evidence** (is it bound to a message?):

| Class | Test | Meaning |
|---|---|---|
| `WIRE ROOT` | strong binding, in-degree 0 | A message. Top-level. |
| `WIRE ROOT + aggregated` | strong binding, in-degree ≥ 1 | Both a message *and* a block inside a larger structure. The interesting case. |
| `ENVELOPE` | in-degree ≥ 3 and first field in ≥ 80% of parents | A header prepended to many messages |
| `ROOT candidate` | in-degree 0, referenced in sources, no binding | Probably a message with no detected pattern yet — feeds §7 |
| `SHARED block` | in-degree ≥ 2 | A reusable building block |
| `block` | in-degree 1 | A block with one parent |
| `orphan` | in-degree 0, no source reference | Declared but unused, or reached only via headers |

**Precedence matters, and this is the part that is easy to get wrong.** Two rules, both
established by getting them wrong first on the fixture:

1. **Envelope beats binding.** `CicHeader` sits textually adjacent to a `MSG_TYPE_*` constant
   in nearly every file, because the idiom is `if (msg->hdr.msg_type == MSG_TYPE_X)`. A naive
   classifier calls it a message root. It is an envelope embedded in 8 messages. Test envelope
   first.
2. **Binding must be *strong*, not proximity.** Strong means `MessageInterface.struct` with
   `structResolved: true`, or a `PayloadResolution` with `high`/`medium` confidence at an actual
   send site — i.e. the struct was resolved at a `cic_bus_send(bus, MSG_TYPE_X, &var, …)` call.
   Textual co-occurrence promotes every shared block that happens to live near a constant
   (`TrackKinematics`, in-degree 4, gets falsely promoted this way). The analyzer already
   produces the strong signal; use it and ignore text proximity entirely.

Most of the machinery exists. `headerGenBundle.ts` has `canonicalName()`, `lookupType()` and a
recursive `walkType()` with `reachedFrom` tracking. Its `topLevel` is deliberately over-broad
(it answers "which headers must header-gen ingest", so it includes every struct used anywhere),
so this is a narrower reuse of the same walk, not new parsing.

### 8.2 Verified output — `synthetic-cic/`

Prototyped against the fixture. All 8 message constants resolve to exactly 8 wire roots,
matching the README's documented ground truth. **This table is the acceptance criterion for the
feature:**

```
STRUCT            in dep fld  CLASS                    EVIDENCE / NOTES
EngageMsg          1   5   5  WIRE ROOT + aggregated   MSG_TYPE_ENGAGE  ← also inside FireDirective
TrackMsg           1   5   6  WIRE ROOT + aggregated   MSG_TYPE_TRACK   ← also inside PictureTable[]
ContactMsg         0   6   3  WIRE ROOT                MSG_TYPE_CONTACT
NavFixMsg          0   4   3  WIRE ROOT                MSG_ID_NAV_FIX
OwnShipMsg         0   4   3  WIRE ROOT                MSG_TYPE_OWN_SHIP
HeartbeatMsg       0   1   2  WIRE ROOT                MSG_TYPE_HEARTBEAT
LinkReportPkt      0   1   4  WIRE ROOT                PKT_TYPE_LINK_REPORT
WeaponOrdMsg       0   1   4  WIRE ROOT                MSG_TYPE_WEAPON_ORD
CicHeader          8   0   4  ENVELOPE                 first field of 8 messages
PictureTable       0   6   2  ROOT candidate           ⚠ var-arr:tracks
SonarFrame         0   1   3  ROOT candidate           ⚠ var-arr:beams
FusedContact       2   5   3  SHARED block             reused by ContactMsg, SonarContact
TrackKinematics    4   4   4  SHARED block             reused by AimSolution, TrackMsg, EngageMsg, FusedContact
MotionState        2   3   3  SHARED block             reused by OwnShipMsg, TrackKinematics
DepthFix           2   2   2  SHARED block             reused by GpsFix, MotionState
AimSolution        1   5   3  block                    inside FireDirective
GpsFix             1   3   2  block                    inside NavFixMsg
GeoCoord           1   1   3  block                    inside DepthFix
BeamBuffer         1   0   4  block                    inside SonarFrame
CicTime            1   0   2  block                    inside GeoCoord
PlatformStamp      1   0   2  block                    inside SonarFrame
FireDirective      0   6   2  orphan (no source ref)
SonarContact       0   6   3  orphan (no source ref)
```

Three things fall out that an analyst would want and that no struct list shows:

- **`CicHeader` is the envelope** — the shared 4-field header on all 8 messages. Composition
  made visible.
- **`TrackMsg` is dual-role** — a wire message on `MSG_TYPE_TRACK` *and* embedded as
  `TrackMsg tracks[CIC_MAX_TRACKS]` in `PictureTable`. Same bytes, two contexts: one on the
  bus, one as an in-memory batch. Exactly the "combination of blocks" case in the question.
- **`PictureTable` and `SonarFrame` carry variable-length arrays** — flagged, because
  `sizeof()` lies about them on the wire.

### 8.3 Where the model comes in

The table is deterministic. The model's job is everything around it:

- **Narrate it** — *"You have 8 wire messages. All share a 4-field `CicHeader` envelope.
  `TrackKinematics` is your most-reused block, appearing in 4 different messages."*
- **Answer follow-ups** via tools — *"which of these cross an app boundary?"* →
  `getCrossAppEdges`; *"what's the wire size of the biggest one?"* → `getStructLayout`.
- **Reason about the `ROOT candidate` rows** — these are the actionable ones. A candidate with
  no binding usually means a messaging wrapper the pattern registry hasn't learned yet, which
  routes straight into the suggest-and-verify flow in §7.
- **Explain the orphans** — `FireDirective` and `SonarContact` are defined and never referenced
  from source. Dead protocol, a missing file, or reached only through a header the analysis
  didn't load.

### 8.4 Delivery

`structRoleAnalyzer.ts` runs as a pass in `analyzeString()` and lands in `StringAnalysis` as
`structRoles`. It is worth building **before** any LLM work: it is a standalone UI section (a
"Message Composition" panel next to Structs), it improves the digest for free — tier 4 stubs
get a class label, so the model knows which structs are roots without a tool call — and it is
exactly the kind of grounded fact the model should be reading rather than inferring.

New tool: `getStructRoles(app)`. Added to the §5 table.

---

## 9. Padding and wire layout — "are there 8 padding bytes between block 1 and block 2?"

No — §8 answers *topology* (who contains whom), not *bytes*. That is a separate question, it is
also deterministic, and for a wire-format tool it is arguably the more important of the two.

### 9.1 What exists, and the gap

`structLayoutEngine.ts` already computes real layout: per-field `offsetBytes`, `sizeBytes`,
`alignBytes`, correct `alignUp()` behaviour, nested struct recursion, and separate 32-bit and
64-bit primitive tables (`PRIM32` / `PRIM64`) selected by the existing `layoutTarget` setting.

What it does **not** do is *report* padding as a located fact. `CStructLayout.paddingBytes` is a
single scalar — `internalPaddingBytes + tail` — so you can learn a struct wastes 7 bytes but not
*where* or *why*. The gaps are recoverable arithmetic
(`next.offsetBytes - (prev.offsetBytes + prev.sizeBytes)`) that nothing currently performs.

### 9.2 What to add — `PaddingGap[]`

```ts
export interface PaddingGap {
  afterField: string | null;     // null = leading; the field the gap follows
  beforeField: string | null;    // null = tail padding
  offsetBytes: number;
  sizeBytes: number;
  reason: 'align-member' | 'align-struct-tail' | 'bitfield-straddle';
  causedByAlign: number;         // the alignment requirement that forced it
  causedByType: string | null;   // the type imposing that alignment
  atCompositionBoundary: boolean; // both neighbours are struct members, not scalars
}
```

Attached to `CStructLayout`, with `paddingBytes` kept as the sum for compatibility.
`atCompositionBoundary` is the flag that answers the question as asked: a gap sitting *between
two embedded blocks*, as distinct from ordinary intra-struct slack.

### 9.3 Verified against `synthetic-cic/`

Computed for `ContactMsg`, the six-level nested payload:

```
===== ContactMsg — 32-bit =====  size=108  align=4
     0  hdr           12B  CicHeader
    12  body          80B  FusedContact
    92  origin        16B  sockaddr_in

===== ContactMsg — 64-bit =====  size=136  align=8
     0  hdr           12B  CicHeader
    12                 4B  <<< PADDING   (composition boundary)
    16  body         104B  FusedContact
   120  origin        16B  sockaddr_in
```

So: **on 64-bit there are 4 padding bytes between `hdr` and `body`; on 32-bit there are none.**
Exactly the question, and the answer depends on the target.

The causal chain is worth surfacing verbatim, because no analyst reconstructs this by eye:

> `FusedContact` requires 8-byte alignment → from `TrackKinematics` → `MotionState` →
> `DepthFix` → `GeoCoord` → `CicTime` → `timeval` → `__time_t` = `long`, which is 8 bytes on
> 64-bit and 4 on 32-bit.

One typedef, six levels down, in a fake `usr/include` tree, silently moves every byte after
offset 12.

### 9.4 The real prize: the 32/64 diff

`layoutTarget` already exists but only renders one target at a time. Computing both and diffing
is nearly free and is the highest-value output in this whole plan for a legacy estate:

| Struct | 32-bit | 64-bit | |
|---|---:|---:|---|
| `CicHeader` | 12B (3 pad) | 12B (3 pad) | stable |
| `timeval` | 8B | 16B | **differs** |
| `CicTime` | 12B | 24B | **differs** |
| `MotionState` | 32B | 48B | **differs** |
| `TrackKinematics` | 44B | 64B | **differs** |
| `FusedContact` | 80B | 104B | **differs** |
| `ContactMsg` | **108B** | **136B** | **differs — 28 bytes** |

If a 32-bit box and a 64-bit box exchange `MSG_TYPE_CONTACT`, every field after the header
lands at the wrong offset and the receiver silently reads garbage. That is a genuine class of
interop bug in a mixed-age estate, it is completely invisible in the source, and the analyzer
can find every instance of it without a model.

Note also `CicHeader`: 9 bytes of data, 12 bytes on the wire — **3 tail padding bytes at the
front of all 8 messages** on both targets. Stable, but it is 3 bytes nobody put there on
purpose.

### 9.5 Two parser bugs this work uncovered — both fixed

Implementing §9 against the real fixture (not a hand-built dictionary) surfaced two
pre-existing defects that made byte offsets wrong wherever they applied. Both are fixed, and
both are the reason the integration test in §13 parses real headers rather than trusting a
transcribed `TypeDict`:

1. **Array members were dropped entirely.** `extractFields` in `headerParser.ts` collected only
   `field_identifier` and `pointer_declarator` nodes. An `array_declarator` — `char
   sin_zero[8]`, `char label[32]`, `char note[64]` — matched neither, fell through to a
   fallback that saw only `;`, and vanished. Every struct with an array member was undersized
   and every offset after it was wrong. `sockaddr_in` came out 3 fields long.
2. **Multi-word typedefs were never registered.** The alias regex was
   `/\btypedef\s+(\w+)\s+(\w+)\s*;/`, so `typedef long __time_t;` matched but
   `typedef unsigned short __sa_family_t;` did not. Unregistered aliases fall through to the
   unknown-type branch and silently take *pointer size* — `sin_family` became 8 bytes instead
   of 2, making `sockaddr_in` 32 bytes instead of 16.

Both failed silently: the layout looked plausible, just wrong. That is the argument for
surfacing `isEstimated` in the UI rather than hiding it — the second bug was visible as an
`estimated` badge before it was diagnosed.

The layout engine also now chases typedef chains to primitives (`time_t` → `__time_t` → `long`),
which it previously did not do at all, and multiplies every array extent so `char grid[2][3]`
counts 6 elements rather than 2.

### 9.6 ⚠ Prerequisite: packing detection

`detectPackAttribute()` was a stub that always returned `undefined`: `CStruct` retained parsed
fields but not the raw attribute text, so `__attribute__((packed))` and `#pragma pack(n)` were
invisible. **Now implemented** — `packDetection.ts` resolves both, and `headerParser` records
the result on `CStruct.packAttribute` / `packSource`.

**Everything in this section is wrong for a packed struct** — packing is precisely the
mechanism that removes the padding being reported. Before padding output is shown to analysts
or handed to the model, `detectPackAttribute` needs a real implementation (retain the raw
declaration span on `CStruct`, or have `headerParser` record pack pragmas as it walks). Until
then any padding view must be badged with whether packing detection ran, and `isEstimated`
must be surfaced rather than hidden.

Reporting confident byte offsets for a struct that is actually packed is worse than reporting
nothing.

### 9.7 Where the model comes in

Same division as §8 — the arithmetic is the analyzer's, the explanation is the model's:

- **Narrate the causal chain.** *"The 4-byte gap exists because `long` is 8 bytes on this
  target, inherited from `timeval` six levels down."* Multi-hop, tedious, exactly what an LLM
  does well over facts it was handed.
- **Answer the follow-ups** — *"which messages change size between targets?"*,
  *"what would reordering `CicHeader` save?"*, *"which of these cross an app boundary?"*
  (→ `getCrossAppEdges`, so a size mismatch on an actual inter-app edge ranks above one on an
  internal message).
- **Never compute offsets.** Every number comes from `getPaddingMap` / `getLayoutDiff`. If the
  model is doing alignment arithmetic in prose, that is a bug.

New tools: `getPaddingMap(struct, target)` and `getLayoutDiff(struct)`. Added to the §5 table.

### 9.8 Delivery

Extends the same phase as §8 — `PaddingGap[]` and the target diff are additions to
`structLayoutEngine.ts`, no LLM dependency, and immediately useful in the existing structs UI as
a byte-map with padding rendered inline. Packing detection (§9.6) is a prerequisite and should
be sequenced first.

---

## 10. The composition view — what the analyst actually reads

§8 gives roles (bottom-up: what contains this struct?). §9 gives bytes. Neither on its own
renders the statement an analyst wants, which is top-down and per message:

> *"`MSG_TYPE_CONTACT` is composed of `CicHeader` + `FusedContact` + `sockaddr_in`."*

That is a third render over the same two datasets, and it is the primary user-facing output of
this whole line of work. Spelling it out so it does not get lost between the two.

### 10.1 Summary render — one line per message

Generated from the fixture, 64-bit target:

```
MSG_TYPE_CONTACT      → ContactMsg       136B (64) /  108B (32) ⚠ SIZE DIFFERS
                        = CicHeader  +  pad(4)  +  FusedContact  +  sockaddr_in

MSG_TYPE_OWN_SHIP     → OwnShipMsg        72B (64) /   48B (32) ⚠ SIZE DIFFERS
                        = CicHeader  +  pad(4)  +  MotionState  +  fix_quality  +  pad(4)

MSG_TYPE_TRACK        → TrackMsg          88B (64) /   64B (32) ⚠ SIZE DIFFERS
                        = CicHeader  +  track_id  +  TrackKinematics  +  source  +  pad(4)

MSG_TYPE_ENGAGE       → EngageMsg         88B (64) /   68B (32) ⚠ SIZE DIFFERS
                        = CicHeader  +  track_id  +  weapon_id  +  auth_flags  +  TrackKinematics

MSG_TYPE_WEAPON_ORD   → WeaponOrdMsg      24B (64) /   24B (32)
                        = CicHeader  +  tube_id  +  track_id  +  weapon_type

PKT_TYPE_LINK_REPORT  → LinkReportPkt     84B (64) /   84B (32)
                        = CicHeader  +  n_tracks  +  own_ship_seq  +  note

MSG_TYPE_HEARTBEAT    → HeartbeatMsg      16B (64) /   16B (32)
                        = CicHeader  +  origin

MSG_ID_NAV_FIX        → NavFixMsg         72B (64) /   44B (32) ⚠ SIZE DIFFERS
                        = CicHeader  +  pad(4)  +  GpsFix  +  quality  +  pad(4)
```

Reading rules: named blocks are struct members (click through to their own composition), bare
lowercase names are scalar fields, `pad(n)` is inserted alignment. Every message is one line;
the whole interface fits on a screen.

**Finding, straight out of the render: 5 of 8 messages change size between targets.** The three
that don't (`WeaponOrdMsg`, `LinkReportPkt`, `HeartbeatMsg`) are exactly the three whose blocks
contain no `long` anywhere in their tree. That is a portability audit nobody had to run.

### 10.2 Expanded render — one message, full tree

```
  ContactMsg                          136B
  + hdr: CicHeader                     12B @0     ENVELOPE (all 8 messages)
      + msg_type, length, seq, checksum  9B
      + <padding>                        3B @9    ← struct tail align
  + <padding>                           4B @12    ← alignment of FusedContact
  + body: FusedContact                104B @16    SHARED block (2 parents)
      + kin: TrackKinematics            64B @16   SHARED block (4 parents)
          + motion: MotionState         48B @16   SHARED block (2 parents)
          + vx, vy, snr                 12B
          + <padding>                    4B @76
      + sensor_id                        4B
      + label[32]                       32B
  + origin: sockaddr_in                16B @120   system type (netinet/in.h)
```

Each line carries: field name, block type, size, absolute offset, and the §8 role. Padding is
rendered inline rather than implied by an offset jump — the gap is a first-class row, because
that is what the question was.

### 10.3 Shape

```ts
export interface MessageComposition {
  msgConstant: string;
  rootStruct: string;
  sizeByTarget: { '32bit': number; '64bit': number };
  differsAcrossTargets: boolean;
  parts: CompositionPart[];   // ordered, offset-sorted, padding included
}

export interface CompositionPart {
  kind: 'block' | 'scalar' | 'padding';
  name: string | null;        // field name; null for padding
  typeName: string | null;    // struct type, for kind: 'block'
  offsetBytes: number;
  sizeBytes: number;
  role?: StructRole;          // from §8 — ENVELOPE / SHARED block / …
  children?: CompositionPart[]; // recursive; depth-capped for render
}
```

Derived, not stored: `MessageComposition` is a projection over `messageInterfaces` +
`structRoles` (§8) + `structCatalog` with `PaddingGap[]` (§9). No new parsing, no new source of
truth — which means it cannot drift from the layout engine.

### 10.4 Why this matters for the model

The one-line summary form is compact enough to go **straight into digest tier 2**. At ~55 tokens
per message, all 8 fixture messages cost ~440 tokens; 400 messages on a large string cost ~22K,
still inside budget.

That means the model knows every message's composition and target-portability **without
spending a tool call** — it only reaches for `getStructLayout` or `getPaddingMap` when a
question needs exact offsets. It also means answers to *"what is `MSG_TYPE_CONTACT` made of?"*
come from a fact in context rather than an inference over a struct list.

New tool for the expanded form: `getMessageComposition(constant, depth)`. Added to §5.

### 10.5 Delivery

Same phase as §8–9, as the UI surface for both: a "Message Composition" panel listing the
summary render, each row expanding to the tree. It is the natural home for the target selector
that `layoutTarget` already backs, and the obvious place to badge the packing-detection caveat
from §9.6.

---

## 11. Scope discipline

The README's headline promise is *"Runs 100% in the browser — zero network calls, zero
backend."* This changes that, and the wording gets updated to "zero internet access; optional
connection to a self-hosted inference server on the local network."

What must not change:

- **Optional and off by default.** With the feature disabled or the vLLM host unreachable,
  every existing code path behaves exactly as today. No analysis pass gains a network
  dependency.
- **Never authoritative.** Struct offsets, message directions and payload types keep coming
  from `structLayoutEngine`, `messagingExtractor` and `payloadResolver`. The model reads them
  via tools; it does not compute them. Anything *actionable* it proposes goes through the
  deterministic analyzer first (§7).
- **No new runtime dependencies.** `fetch`, SSE parsing and JSON Schema literals are hand-rolled
  in well under 300 lines. Nothing added to the airgap transfer burden.

---

## 12. Phases

| Phase | Scope | Ships |
|---|---|---|
| **0** | `LlmConfig`, settings panel, `client.ts`, health check + `max_model_len` discovery, nginx proxy + entrypoint templating, docker-compose | Plumbing verified against the real vLLM host. Panel visible, no analysis awareness. |
| **1** | `digest.ts` + snapshot tests against `synthetic-cic/`. Context inspector UI. | Digest inspectable/exportable before any model sees it. Fully testable with no server. |
| **2** | Ask panel: scope selector, streaming answers, cancel, reasoning disclosure, citation chips wired to drill-down | The core feature. Digest-only, no tools. |
| **3** | `tools.ts` + the split streaming/non-streaming request loop + tool-call trace UI | Deep struct nests and exact line numbers become reliable. |
| **1.4** | `detectPackAttribute()` real implementation (§9.5) — retain raw declaration span or record pack pragmas in `headerParser` | Prerequisite for trusting any byte offset. |
| **1.5** | `structRoleAnalyzer.ts` — containment graph, root/envelope/block classification, `structRoles` on `StringAnalysis`; `PaddingGap[]` + 32/64 target diff (§9); `MessageComposition` projection + "Message Composition" UI panel (§10) | Pure analyzer work, no LLM. Useful on its own; improves the digest and grounds §8–9 questions. |
| **4** | Pattern suggestion with analyzer verification (§7); canned analyses for unresolved structs / unknown directions / `headerGenBundle.review` | The force-multiplier phase. |

Phases 0–2 are independently useful. Phase 3 is what makes it trustworthy on a large codebase.
Phase 4 is where it saves real analyst hours.

---

## 13. Testing

- `digest.test.ts` — snapshot the digest for each `synthetic-cic/` app; assert budget is
  respected, ordering is stable, and byte-identical output across runs (the prefix-cache
  guarantee).
- `digest.degradation.test.ts` — walk the budget down from generous to absurd (32K → 8K → 2K →
  200) against a synthetically inflated analysis, and assert at every step: tier priority is
  honoured, tiers 1–2 survive longest, `omitted[]` accounts for **everything** dropped with no
  silent truncation, and the tier-1-plus-`searchMessages` floor is reached rather than an
  empty digest. This is the test that protects the property that actually matters — the model
  is never quietly missing context it thinks it has.
- `structRoles.test.ts` — assert the §8.2 table exactly, against `synthetic-cic/`: all 8 message
  constants map to 8 wire roots, `CicHeader` classifies as `ENVELOPE` (not a root), `TrackMsg`
  as dual-role, `TrackKinematics` as a shared block (the proximity false-positive), and the
  variable-length arrays in `PictureTable`/`SonarFrame` are flagged.
- `composition.test.ts` — assert the §10.1 summary for all 8 fixture messages: correct part
  ordering, `pad(4)` rows present where §9 says, and exactly 5 of 8 flagged
  `differsAcrossTargets`. Guards the projection against drift from the layout engine.
- `padding.test.ts` — assert the §9.3 byte map for `ContactMsg` on both targets: the 4-byte
  composition-boundary gap at offset 12 on 64-bit and its absence on 32-bit, `CicHeader`'s 3
  tail bytes, and the full §9.4 size table. `timeval` → `__time_t` → `long` is the mechanism, so
  this doubles as a regression test on typedef-chase depth through the fake `usr/include` tree.
- `tools.test.ts` — each executor against the fixture analyses, including the six-level
  `ContactMsg` nest and the `timeval`/`sockaddr_in` system types from the fake include tree.
  Assert unknown tool names and out-of-range args return structured errors, not throws.
- `client.test.ts` — against a mocked `fetch`: SSE frame parsing (split chunks, `[DONE]`,
  mid-stream error objects, abort), `tool_calls` assembly from a non-streamed response, and
  `reasoning_content` separation.
- Pattern suggestion — feed known-good and known-bad `CustomPattern` JSON through the
  verification gate; assert bad regexes and zero-match patterns never surface.
- Everything above runs offline in `vitest`. **No test requires a model.**
- Manual: `synthetic-titan/` is the end-to-end case for Phase 4 — its `titan_send_message` bus
  is exactly the wrapper the suggester should find, and `test-fixtures/cid-config.json` holds
  the ground-truth pattern to compare against.

---

## 14. Open questions

1. **vLLM version on the serving host.** Not currently known, and **not blocking**: non-streaming
   tool turns and `response_format` work on every version, so the design is safe either way. It
   only decides whether `streamToolTurns` can eventually be flipped on. Findable in seconds when
   convenient — `curl -s http://<vllm-host>:8000/version`, or read the container image tag.
   Worth knowing because it also tells you whether the OpenCode flakiness in
   [#42696](https://github.com/vllm-project/vllm/issues/42696) applies to your existing setup.
2. **Served `max_model_len`.** 262,144 on the card, but deployments differ. Read from
   `/v1/models`; worth confirming what the host is actually configured for, since it sets the
   digest budget ceiling.
3. **Concurrency.** One shared GPU across N analysts, or per-workstation? Affects timeout
   aggressiveness and whether the UI needs a queue indicator. Also relevant to
   [#39392](https://github.com/vllm-project/vllm/issues/39392) — the `<pad>`-token defect is
   concurrency-triggered.
4. **Scope of "all applications".** On a large deployment the cross-app digest may exceed even a
   generous budget. Options: hard-cap at N apps, or make cross-app questions tool-first with
   only the app inventory in the initial context.
