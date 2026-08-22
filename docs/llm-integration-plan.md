# LLM Integration Plan — Asking Questions About Analysis Output

Status: **proposed**, not implemented. Target backend: **Gemma served by vLLM** on the
airgapped network.

The goal: after the analyzer has produced a `StringAnalysis` for each application, an analyst
can ask natural-language questions about it — *"which apps consume `MSG_TYPE_TRACK` and what
struct do they expect?"*, *"why is the direction on `MSG_TYPE_WEAPON_ORD` unknown?"*,
*"what would a custom pattern for `titan_send_message` look like?"* — and get answers grounded
in the analyzer's own output rather than in the model's guesses.

---

## 1. The constraint that shapes everything

The README's headline promise is **"Runs 100% in the browser — zero network calls, zero
backend."** An LLM integration breaks the literal form of that promise. It must not break the
spirit of it:

- **Airgap-preserving.** The only new network destination is a vLLM server on the *same*
  isolated network. No egress. Nothing leaves the enclave.
- **Optional and off by default.** With the feature disabled, or with the vLLM host
  unreachable, every existing code path behaves exactly as it does today. No analysis pass
  gains a network dependency. The tool ships and runs standalone.
- **Never authoritative.** The LLM reads analyzer output; it does not replace it. Struct
  offsets, message directions and payload types keep coming from `structLayoutEngine`,
  `messagingExtractor` and `payloadResolver`. Anything the model proposes that is *actionable*
  (see §7) gets fed back through the deterministic analyzer before the analyst sees a result.

README and spec wording get updated to "zero internet access; optional connection to a
self-hosted inference server on the local network."

---

## 2. Deployment topology

Two containers on the airgapped host. The app container reverse-proxies the model.

```
browser ──http──> nginx (app container :80)
                    ├── /            → static SPA
                    └── /llm/…       → proxy_pass http://vllm:8000/…
                                        (vLLM OpenAI-compatible server, Gemma)
```

**Why proxy instead of calling vLLM directly from the browser:**

1. `nginx.conf` sets `Cross-Origin-Embedder-Policy: require-corp` (needed for tree-sitter
   WASM). A cross-origin `fetch` to vLLM then requires correct CORS *and* CORP headers from
   vLLM. Same-origin sidesteps all of it.
2. No CORS config needed on the vLLM side (`--allowed-origins` etc.).
3. No mixed-content problem if the app is ever served over HTTPS.
4. The vLLM host/port becomes a *deployment* concern (one env var at `docker run` time), not a
   thing every analyst pastes into a settings box on every workstation.

Settings-box entry of a raw endpoint URL stays supported as an escape hatch for the dev-mode
workflow, but the proxy is the documented path.

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
health check in §3 reads as "LLM unavailable", and the UI hides itself.

A `docker-compose.yml` is added showing app + vLLM together, for sites that want it. The
single-image `docker run` path in the README keeps working unchanged.

---

## 3. Provider layer — `src/llm/`

New module, no dependencies on React, unit-testable without a server.

```
src/llm/
  client.ts        # fetch wrapper: chat(), chatStream(), listModels(), health()
  config.ts        # LlmConfig type, localStorage persistence, defaults
  digest.ts        # StringAnalysis  → compact grounded context  (§4)
  retrieval.ts     # deterministic query functions over the analysis (§5)
  prompts.ts       # system prompts + task templates
  schemas.ts       # JSON Schemas for structured responses (§5, §7)
  __tests__/
```

### `LlmConfig`

```ts
export interface LlmConfig {
  enabled: boolean;
  baseUrl: string;        // default '/llm' (the nginx proxy)
  model: string;          // e.g. 'google/gemma-3-27b-it' — populated from /v1/models
  apiKey?: string;        // vLLM --api-key, if the site sets one
  temperature: number;    // default 0.2 — this is an analysis tool, not a writing tool
  maxTokens: number;      // response cap, default 1500
  contextBudgetTokens: number;  // digest size cap, default 24000 (§4)
  includeSourceSnippets: boolean; // default false — see §8
}
```

Persisted in `localStorage` under `cid_llm_config`, alongside the existing pattern registries.
Deliberately **not** in the exportable `cid-config.json`, which is shared between analysts and
should not carry a per-workstation endpoint or an API key.

### Wire protocol

vLLM's OpenAI-compatible `POST /v1/chat/completions`, `stream: true`, parsed as SSE.
`AbortController` on every request so the analyst can cancel a running generation.

**Structured responses use `response_format: { type: "json_schema", ... }`, not
`guided_json`.** The `guided_*` extra-body fields were deprecated and **removed in vLLM
v0.12.0** in favour of `structured_outputs: { json: … }`; `response_format` is the
OpenAI-standard spelling, is accepted across vLLM versions, and is the one field that will not
need revisiting on the next upgrade. This matters more than usual here — see §5.

### Health check

On mount (and on settings save): `GET {baseUrl}/v1/models`. Success populates the model
dropdown and flips the UI on. Failure (404, connection refused, timeout) leaves every LLM
affordance hidden and shows a single unobtrusive line in settings. No retries, no console
noise, no impact on analysis.

---

## 4. Grounding: the analysis digest

The model must answer from analyzer output, so that output has to reach the prompt. The
central problem is **size**. `StringAnalysis` serialized naively is enormous — `typeDict`
alone can hold thousands of structs on a real combat-system string, plus `structCatalog` with
per-field byte layouts, `usedIn` line references, and `payloadResolutions` per send site.

`digest.ts` exports:

```ts
export interface DigestOptions {
  budgetTokens: number;
  scope: { kind: 'app'; appId: string } | { kind: 'all' } | { kind: 'message'; constant: string };
  includeSourceSnippets: boolean;
}

export interface AnalysisDigest {
  text: string;              // the markdown block that goes in the prompt
  estimatedTokens: number;
  omitted: DigestOmission[]; // what was dropped and why — rendered in the UI
}
```

**Tiered inclusion.** Fill the budget in priority order, and record every omission:

| Tier | Content | Notes |
|---|---|---|
| 1 | App inventory: names, file counts, per-app produced/consumed message constants | Always. Tiny. |
| 2 | `MessageInterface` table: constant, value, struct name, direction + confidence, transport, `definedIn`, producing/consuming files | The primary deliverable. Always. |
| 3 | Cross-app edges from `buildAppGraph`, including detected transit/broker routing | Always. Small. |
| 4 | Struct *shapes* for structs referenced by a message interface: field names + types, total size, from `structCatalog` | Truncate long structs to first N fields + `… (k more fields)` |
| 5 | Unresolved items: `structResolved: false`, `direction: 'unknown'`, `incomplete`, `payloadResolutions` with `confidence: 'low' \| 'unresolved'`, `headerGenBundle.review` | High analyst value — these are exactly the questions people ask |
| 6 | `unknownCalls` and unmatched IPC calls, deduped and frequency-ranked | Feeds the pattern-suggestion flow (§7) |
| 7 | Risk flags, defines, enums, full function inventories | First to be dropped |

Source snippets are **never** in the digest. They arrive only through retrieval (§5), only when
the analyst has enabled it, and only the specific lines asked for.

**Token estimation** uses `chars/3.5` — deliberately pessimistic for C identifiers, which are
long and split into many tokens. It does not need to be exact; it needs to never
under-estimate. If precision is ever needed, vLLM exposes `POST /tokenize`, but that is an
extra round trip per keystroke and is not worth it.

**Determinism.** Given the same `StringAnalysis` and options, `buildDigest` returns
byte-identical output. Stable sort on every collection. This makes it testable — the fixtures
in `test-fixtures/synthetic-cic/` become digest snapshot tests — and it makes prompt caching on
the vLLM side effective across turns of a conversation.

---

## 5. Retrieval, and the Gemma tool-calling problem

Tier 4–7 truncation means the model will regularly need something the digest dropped: the full
field list of a struct, every line where a constant appears, the source of one function. The
answer is a retrieval loop.

**The complication:** standard Gemma has no first-class tool-call parser in vLLM. vLLM ships
parsers for Hermes, Mistral, Llama-3 JSON, Granite and others, plus a `functiongemma` parser
for Google's purpose-built 270M FunctionGemma; general Gemma 3 tool calling has been an open
request rather than a supported flag. Building the design on `--enable-auto-tool-choice
--tool-call-parser <x>` would couple us to a serving configuration the site may not have.

**So: don't use native tool calling.** Use constrained decoding instead, which is
model-agnostic and works on any vLLM-served model:

1. Turn 1 — send digest + question, with
   `response_format: { type: 'json_schema', json_schema: RETRIEVAL_REQUEST_SCHEMA }`.
   The model returns either `{"action":"answer"}` or
   `{"action":"retrieve","queries":[{"fn":"getStructLayout","args":{"name":"FusedContact"}}, …]}`.
2. The app executes those queries **locally in TypeScript** against the in-memory
   `StringAnalysis`. No model involvement, no hallucination surface.
3. Turn 2 — resend with the retrieved facts appended, unconstrained, streaming, for the prose
   answer.

Two round trips, bounded (max one retrieval hop, max 8 queries), fully deterministic in the
part that touches data.

### Query surface — `retrieval.ts`

Every one of these is a pure function over `StringAnalysis` and already has an implementation
or near-equivalent in the codebase:

| Query | Backed by |
|---|---|
| `getMessageInterface(constant)` | `analysis.messageInterfaces` |
| `getStructLayout(name)` | `structCatalog.layouts` — real byte offsets, padding, size |
| `getStructGraph(name, depth)` | recursive walk; the CIC fixture nests six levels |
| `findUsages(symbol)` | `utils/findReferences.ts` + `MessageInterface.usedIn` |
| `getPayloadResolutions(file?, constant?)` | `analysis.payloadResolutions` |
| `getSourceLines(file, from, to)` | `LoadedFile.content` — gated by `includeSourceSnippets` |
| `getUnknownCalls(app)` | `FileAnalysis.unknownCalls` |
| `getCrossAppEdges(constant?)` | `utils/buildAppGraph.ts` |
| `getHeaderGenReview(app)` | `headerGenBundle.review` |

Retrieval results carry their provenance (`file`, `line`, `sourceFile`) and the prompt requires
the model to cite it. Citations render as click-through links into the existing drill-down view
— §6.

**Fallback if constrained decoding is unavailable** (older vLLM, xgrammar disabled): skip the
retrieval turn entirely and answer from the digest alone, with a visible "retrieval
unavailable — answering from summary only" badge. Capability is probed once at health-check
time by issuing a trivial schema-constrained request.

---

## 6. UI

A right-hand **Ask** panel, toggled from the header, available in both IPC and Interface mode.
No new routes, no change to the existing layout when it is closed.

- **Scope selector** at the top: *This application* / *All applications* / *This message*.
  Scope drives `DigestOptions.scope`. Opening the panel from an app-graph edge or a message
  card pre-scopes it to that message.
- **Context inspector** — a collapsed "N tokens of context · what's included?" line that
  expands to show the exact digest text being sent and the `omitted[]` list. Analysts working
  with sensitive source get to see precisely what goes over the wire before it does. This is
  not optional polish; see §8.
- **Streaming answer** with a cancel button.
- **Citations** rendered as chips — `array_pub.c:142`, `struct ContactMsg` — that call the
  existing `setActiveFile` / drill-down handlers. This is the feature that makes the panel part
  of the tool rather than a chatbot bolted onto it.
- **Conversation** kept in React state only. Not persisted to IndexedDB — the session store is
  for files, and chat transcripts about classified source are not something to leave on disk
  by default.
- **Suggested questions** seeded from the analysis itself: if `messageInterfaces` has entries
  with `structResolved: false`, offer *"Why couldn't these 3 message structs be resolved?"*.

---

## 7. The high-value case: LLM proposes, analyzer verifies

The README's first known limitation is:

> Custom messaging wrappers not detected until manually added to the pattern registry

Today an analyst reads `unknownCalls`, recognises `titan_send_message(handle, MSG_ID, &buf,
len)` as a transport wrapper, and hand-writes a regex plus arg indices in the pattern
registry. That is exactly the kind of pattern-recognition-over-unfamiliar-code task a model is
good at, *and* — critically — the result is **machine-checkable**.

Flow:

1. Model receives the ranked `unknownCalls` list with a few representative call sites, and a
   `response_format` pinned to the `CustomPattern` shape: `pattern`, `ipcType`, `direction`,
   `msgArgIndex`, `payloadArgIndex`, `lengthArgIndex`, `msgConstantPattern`, `notes`.
2. The app **compiles the regex and runs it against the loaded corpus** before showing
   anything — reusing `refreshMatchCounts()`, which already exists in `App.tsx`.
3. The analyst sees: proposed pattern, match count, and up to 10 real matching lines. An
   invalid regex or zero matches is rejected silently and the suggestion is never displayed.
4. **Accept** routes through the existing `handleAddPattern` → `handleReanalyze` path.
   Nothing bypasses the normal registry.

The model never touches analysis output directly. It writes a *hypothesis*; the deterministic
analyzer is the judge. Same pattern applies to `MsgStructPattern` suggestions, where
`handleDetectMsgStructs()` already does the heuristic half of the job.

This is the part of the integration worth building even if the chat panel never gets used.

---

## 8. Data handling

This tool is pointed at submarine combat system source. Two things follow.

**Be explicit about what is transmitted.** Even a local vLLM server logs prompts by default,
holds them in GPU memory, and is administered by someone. The context inspector (§6) exists so
"what did we send to the model" is answerable by looking, not by reading source. Default
`includeSourceSnippets: false` means the baseline digest is *derived metadata* — symbol names,
types, offsets, line numbers — not verbatim code. Turning snippets on is a deliberate,
per-workstation act.

**Redaction hook.** `digest.ts` takes an optional `redact?: (s: string) => string` applied to
every string before it enters the prompt, so a site that needs identifier scrubbing has one
place to implement it rather than auditing every call site later.

Worth confirming with whoever owns the accreditation before Phase 1 lands: is a GPU host
running an inference server an approved component on this enclave, and does prompt logging on
that host need to be disabled?

---

## 9. Phases

| Phase | Scope | Ships |
|---|---|---|
| **0** | `LlmConfig`, settings panel, `client.ts`, health check, nginx proxy + entrypoint templating, docker-compose | Feature flag on, panel visible, no analysis awareness. Verifies the plumbing against a real vLLM host. |
| **1** | `digest.ts` + snapshot tests against `synthetic-cic/`. Context inspector UI. | Digest is inspectable/exportable before any model sees it. Fully testable with no server. |
| **2** | Ask panel: scope selector, streaming answers, cancel, citation chips wired to drill-down | The core feature. Digest-only, no retrieval. |
| **3** | `retrieval.ts` + constrained-decoding hop + capability probe + fallback badge | Answers about deep struct nests and specific line numbers become reliable. |
| **4** | Pattern suggestion with analyzer verification (§7); canned analyses for unresolved structs / unknown directions / `headerGenBundle.review` | The force-multiplier phase. |

Phases 0–2 are independently useful and can stop there. Phase 3 is what makes it trustworthy
on a large codebase. Phase 4 is where it saves real analyst hours.

No new runtime dependencies at any phase — `fetch`, SSE parsing and JSON Schema literals are
all hand-rolled in well under 300 lines. Nothing added to the airgap transfer burden.

---

## 10. Testing

- `digest.test.ts` — snapshot the digest for each `synthetic-cic/` app; assert budget is
  respected, ordering is stable, tier priority holds under a squeezed budget, and `omitted[]`
  accounts for everything dropped.
- `retrieval.test.ts` — each query function against the fixture analyses, including the
  six-level `ContactMsg` nest and the `timeval`/`sockaddr_in` system types.
- `client.test.ts` — SSE frame parsing (split chunks, `[DONE]`, mid-stream error objects,
  abort) against a mocked `fetch`. No server required.
- Pattern suggestion — feed known-good and known-bad `CustomPattern` JSON through the
  verification gate; assert bad regexes and zero-match patterns never surface.
- Everything above runs offline in `vitest`. **No test requires a model.**
- Manual: `synthetic-titan/` is the natural end-to-end case for Phase 4 — its
  `titan_send_message` bus is precisely the wrapper the suggester should find, and
  `test-fixtures/cid-config.json` holds the ground-truth pattern to compare against.

---

## 11. Open questions

1. **Which Gemma, and what context length?** Gemma 3 gives 128K (except the 1B at 32K); Gemma 2
   gives 8K. At 8K the digest is essentially the message table alone and Phase 3 retrieval
   becomes mandatory rather than an improvement. This is the single biggest input to the
   `contextBudgetTokens` default and to how aggressively tiers 4–7 truncate.
2. **vLLM version.** Determines whether `structured_outputs` or the removed `guided_*` fields
   are in play, and whether xgrammar-backed `response_format` is available for Phase 3. The
   plan targets `response_format` for exactly this reason, but the capability probe needs a
   real server to validate against.
3. **Concurrency.** One shared GPU across N analysts, or per-workstation? Affects whether the
   UI needs a queue indicator and how aggressive the timeout should be.
4. **Accreditation.** §8 — is an inference host approved on this enclave, and is prompt logging
   acceptable?
5. **Scope of "all applications".** On a large deployment the cross-app digest may not fit any
   budget. Options: hard-cap at N apps, or make cross-app questions retrieval-first with only
   the app inventory in the initial context.
