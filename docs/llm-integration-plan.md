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

## 8. Scope discipline

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

## 9. Phases

| Phase | Scope | Ships |
|---|---|---|
| **0** | `LlmConfig`, settings panel, `client.ts`, health check + `max_model_len` discovery, nginx proxy + entrypoint templating, docker-compose | Plumbing verified against the real vLLM host. Panel visible, no analysis awareness. |
| **1** | `digest.ts` + snapshot tests against `synthetic-cic/`. Context inspector UI. | Digest inspectable/exportable before any model sees it. Fully testable with no server. |
| **2** | Ask panel: scope selector, streaming answers, cancel, reasoning disclosure, citation chips wired to drill-down | The core feature. Digest-only, no tools. |
| **3** | `tools.ts` + the split streaming/non-streaming request loop + tool-call trace UI | Deep struct nests and exact line numbers become reliable. |
| **4** | Pattern suggestion with analyzer verification (§7); canned analyses for unresolved structs / unknown directions / `headerGenBundle.review` | The force-multiplier phase. |

Phases 0–2 are independently useful. Phase 3 is what makes it trustworthy on a large codebase.
Phase 4 is where it saves real analyst hours.

---

## 10. Testing

- `digest.test.ts` — snapshot the digest for each `synthetic-cic/` app; assert budget is
  respected, ordering is stable, and byte-identical output across runs (the prefix-cache
  guarantee).
- `digest.degradation.test.ts` — walk the budget down from generous to absurd (32K → 8K → 2K →
  200) against a synthetically inflated analysis, and assert at every step: tier priority is
  honoured, tiers 1–2 survive longest, `omitted[]` accounts for **everything** dropped with no
  silent truncation, and the tier-1-plus-`searchMessages` floor is reached rather than an
  empty digest. This is the test that protects the property that actually matters — the model
  is never quietly missing context it thinks it has.
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

## 11. Open questions

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
