# LLM Integration — Design Rationale

Status: **implemented**. The plan this file started as has shipped; what is kept here is the
reasoning that is not readable off the code — the model assumptions and the measured numbers
behind the context strategy.

Where the rest went:

- Operating it (proxy env var, vLLM serve flags, docker-compose) — `README.md`, "Optional LLM assistant".
- Provider layer, turn shape and the vLLM streaming tool-parser caveat — module headers in `src/llm/`.
- Struct roles, padding maps, composition view — module headers in `src/analyzer/`.
- Phase plan and delivery checklists — the git log.

Not yet verified against the real endpoint. That verification is the point of the endpoint
diagnostics in `src/llm/diagnostics.ts`: run it once after the media transfer and the result is
the acceptance test.

---

## 1. Model assumptions

Gemma 4 26B A4B, per Google's model card:

| Property | Value | Consequence for this design |
|---|---|---|
| Architecture | MoE, 25.2B total / ~3.8B active per token | Cheap enough to serve per-site; fast decode |
| Context window | 262,144 tokens (256K) | Whole-analysis context is viable — but see §4 on why we still don't stuff it |
| Max output | 32,768 tokens | Never the binding constraint here |
| Function calling | **Native** | Standard OpenAI `tools` / `tool_calls`; no prompted-JSON workaround |
| Thinking | Configurable reasoning mode | Separate `reasoning_content` field; affects UI and token accounting; see `src/llm/conversation.ts` |
| License | Apache 2.0 | No redistribution friction for the airgap transfer |

**Do not hardcode the context length.** Deployments vary — Cloudflare Workers AI serves this
model at 131,072 despite the 256K card figure. `GET /v1/models` reports the served
`max_model_len`; read it at health-check time and derive the digest budget from it (§4).

Since the endpoint already works with OpenCode, the tool-calling path is configured and
proven. The OpenCode provider config is the fastest source of truth for base URL and exact
model ID — lift them rather than rediscovering them.

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
| 6 | `unknownCalls` / unmatched IPC, deduped and frequency-ranked | 23 tok | Feeds pattern suggestion |
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
