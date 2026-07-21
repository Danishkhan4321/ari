# Ari agent runtime

Ari and Codex are explicit provider modes. They share Ari's canonical business
tool contracts and safety policy, but not model-process state.

## Runtime boundary

- `ari`: pinned `agno==2.7.4` using Agno's native `Gemini` or official
  `OpenRouter` model. A one-shot Python worker plans; Node owns every business
  side effect.
- `codex`: direct Codex login through Codex App Server, only when the desktop
  user selected Codex and the account is connected. Login credentials never
  leave the App Server and are never treated as an OpenAI API key.
- `openrouter`: pinned `@openrouter/agent@0.7.2` compatibility fallback, only
  before a tool begins.
- `legacy`: operator rollback through `ARI_AGENT_RUNTIME=legacy`.

The removed default path was:

```text
controller -> Codex App Server -> local Ari Responses gateway
           -> provider adapter -> model -> App Server -> tool callback
```

The primary Ari path is:

```text
controller -> current-turn selector -> Agno/(Gemini or OpenRouter) -> typed FunctionCall
           -> Node validation/journal/confirmation -> executeIntent
```

## Conversation and execution state

Every request supplies explicit `user_id` and `session_id`. Agno stores session
history and summaries in Postgres tables configured by `ARI_AGNO_*_TABLE`,
regardless of whether the model is direct Gemini, Vertex Gemini, or OpenRouter.
Dashboard sessions and rolling messaging conversations use different identities,
so one user's or one chat's history cannot seed another.

Codex keeps its provider-owned thread separately. Ari also stores a bounded,
credential-redacted cross-provider summary in
`ari_agent_conversation_summaries`. A fresh Codex thread or Agno session
receives that canonical summary as explicitly untrusted historical data. This
supports provider switching without exporting Codex credentials or replaying a
provider's private tool-call transcript.

Node takes a Postgres advisory lock per hashed conversation and journals each
`(conversation, tool_call_id)` in `ari_agent_tool_executions`. A repeated call
returns its completed typed result. A timed-out or interrupted mutation becomes
non-retryable `unknown_outcome` and is never blindly replayed.

Useful durable facts are separate from chat history. `ari_agent_memory_fact_versions`
is append-only: explicit corrections supersede older facts and expiry suppresses
stale values. Secret-like values are rejected before persistence. The legacy
`memory_trunk` is only a current projection during migration.

The current tool result is authoritative. If model prose claims "done" after a
failure, clarification, approval preview, tool limit, or uncertain mutation,
Node returns the deterministic terminal summary instead. `clear_chat_history`
deletes both the Node conversation journal and the tenant-filtered Agno session
after the successful run is saved.

Run migrations before enabling the runtime:

```powershell
npm run migrate
```

## Tool loop

Agno owns model planning, exact function-call/result pairing, history, and
summaries. Ari adds the business-specific boundaries:

- current-turn explicit, domain, and typo-tolerant signals select a compact
  typed subset before stale history is considered;
- each current requested domain reserves a slot, so compound requests do not
  lose their last capability at the tool cap;
- function calls are serialized (`parallel_tool_calls=false`) because many
  CRM/calendar/email tools mutate shared state;
- schemas reject unknown fields locally before the legacy handler bridge;
- every tool has a timeout and a non-retryable unknown-outcome state;
- confirmation prompts are normalized as `waiting_approval`, not success;
- clarification prompts become `waiting_for_user` run states;
- null, unconfigured-provider, and authentication failures are not success;
- unknown tools, invalid inputs, and Agent-SDK-intercepted validation errors
  become terminal failed tool results even if later model prose says "Done";
- large observations retain compact IDs and records needed by later steps.

The configured tool cap is enforced before journal claims or mutations.
Cancellation aborts model/tool work, blocks queued tools, waits for active tool
journal finalization, and keeps dashboard channel suppression active until the
run has actually terminated. Codex App Server also sends `turn/interrupt` and passes
the signal through the CRM tool boundary. If Stop races an already-running
business mutation, Ari waits for a short drain and records the outcome as
`partial`/unknown rather than falsely claiming a clean cancellation.

Codex App Server thread identity is retained only for a genuinely `completed`
typed outcome. Failed, partial, approval, clarification, and interrupted turns
invalidate that provider thread so untrusted terminal prose cannot be replayed
into the next turn.

The loop supplies explicit output-token, tool, request, and overall limits.
The NDJSON bridge additionally caps each envelope and stderr/stdout buffer,
validates protocol version 1, and treats a broken worker pipe as failure rather
than waiting indefinitely.

## Typed invocation contract

Natural language is used to select a compact set of capabilities, but it is
not the execution contract. Once the model emits a function call, the canonical
tool name and validated JSON arguments are authoritative. An adapter must
consume every advertised field directly or remove it from the schema; it must
not recover typed values by reparsing synthesized prose. Stable IDs must be
resolved inside the current tenant/session, and a missing ID must not silently
fall back to the newest record.

Confirmation-resolution tools are valid only for the matching active pending
action. A stale or context-free approve/reject call returns a waiting-input
result instead of selecting another pending action. These boundaries are
covered by `agent-tool-contracts`, `agent-tool-selector`,
`typed-tool-handler-fidelity`, `agent-typed-email-calendar`, and
`confirmation-policy` in `npm run test:agent`.

## Files

PDF analysis uses OpenRouter's `file-parser` plugin. The default parser is
`cloudflare-ai` (free Markdown extraction); set `OPENROUTER_PDF_ENGINE` to
`mistral-ocr` or `native` when appropriate. XLSX, CSV, and DOCX retain the
existing OpenAI/Anthropic fallbacks because OpenRouter's universal parser is a
PDF feature.

For parsed PDFs, Ari stores the full SDK state and deduplicated file annotations
in `ari_file_analysis_cache`, scoped to the user/dashboard session and keyed by
the local file SHA-256. Follow-up questions reuse that parsed state without
embedding or reparsing the original PDF bytes. This is why migration 22 must be
applied before expecting cross-turn PDF continuity.

Dashboard multi-file sends are one logical turn: every attachment is first
saved in a no-agent/no-history batch, then the caption is submitted exactly
once. Document context exposes the whole batch to analysis and email tools. A
session-store failure rolls back that message's staged rows/files before the
bot handoff. If backend ingestion saves an earlier file and a later file fails,
Ari stops before the caption/action, retains the successful file, and persists
one user turn plus an explicit partial/failure reply with exact counts.

The dashboard is the file writer and the bot/Agno worker is the reader. Both
must receive the same **absolute** `ARI_SESSION_ATTACHMENT_DIR`; a relative
value is invalid operationally because the processes have different working
directories. Ari Desktop injects one shared absolute directory. Docker Compose
uses and mounts `/app/.ari-session-attachments`.

Before Agno sees a file, the Python worker independently requires a strict
current-turn `session:<uuid>` descriptor, resolves it under that root, rejects
unknown descriptor fields, symlinks, non-regular files, duplicate IDs/paths,
and size or optional SHA-256 mismatches. Failures use one non-enumerating error
message. Defaults allow at most 10 files, 25 MiB each, and 50 MiB total; adjust
them with `ARI_AGENT_FILE_MAX_COUNT`, `ARI_AGENT_FILE_MAX_BYTES`, and
`ARI_AGENT_FILE_TOTAL_MAX_BYTES`. The non-configurable ceilings are 50 files,
100 MiB per file, and 250 MiB total.

Messaging uploads use stable `user_file:<id>` artifact IDs. Supabase object
storage is preferred when configured. If it is unavailable, Ari writes the
bytes beneath the same confined attachment root and migration 30 records the
local path, size, and SHA-256 digest. Reads re-check path confinement, file
type/size, and digest; deleting the database-owned file also removes its local
bytes. The attachment root must therefore be a durable mounted volume, not an
ephemeral container directory.

## Configuration

See `.env.example`. A direct-Gemini production configuration is:

```dotenv
DATABASE_URL=postgres://ari:ari@localhost:5432/ari?sslmode=disable
ARI_AGENT_RUNTIME=agno
ARI_AGNO_MODEL_PROVIDER=gemini
ARI_AGNO_MODEL_ID=your-supported-gemini-model
ARI_AGNO_PYTHON=python
ARI_AGNO_WORKER=agno_runtime/worker.py
ARI_SESSION_ATTACHMENT_DIR=/absolute/path/to/ari-session-attachments
GEMINI_API_KEY=...
ARI_AGNO_HISTORY_RUNS=4
ARI_AGNO_HISTORY_TOOL_CALLS=12
ARI_AGNO_SESSION_SUMMARIES=true
```

Vertex Gemini additionally sets `ARI_AGNO_GEMINI_VERTEX=true`,
`GOOGLE_VERTEX_PROJECT`, `GOOGLE_VERTEX_LOCATION`, and ADC or
`GOOGLE_APPLICATION_CREDENTIALS`. OpenRouter sets
`ARI_AGNO_MODEL_PROVIDER=openrouter`, `OPENROUTER_API_KEY`, and
`OPENROUTER_MODELS`. Leaving `ARI_AGNO_MODEL_PROVIDER` blank preserves
backward compatibility: OpenRouter wins when its key exists; otherwise a
configured Gemini credential is selected.

`OPENROUTER_REASONING_EFFORT` belongs only to the direct
`@openrouter/agent` compatibility runtime. The Agno model path does not
consume it, so it is intentionally not part of the minimum Agno configuration.

Install the pinned Python dependencies (including `google-genai`) with
`npm run setup:agno`, then run `npm run migrate`. No provider key is committed.
If the selected provider is unavailable, Ari logs the compatibility runtime
selection. Once a tool starts, runtime fallback is prohibited because it could
duplicate an external effect.

## Verification

```powershell
npm run test:agent
npm run test:agno
npm test
npm run eval
npm run eval:provider-parity
```

## Primary sources

- <https://docs.agno.com/models/providers/native/google/overview>
- <https://docs.agno.com/models/providers/gateways/openrouter/overview>
- <https://github.com/agno-agi/agno/blob/v2.7.4/libs/agno/agno/tools/function.py>
- <https://github.com/agno-agi/agno/blob/v2.7.4/libs/agno/agno/models/openrouter/openrouter.py>
- <https://github.com/agno-agi/agno/blob/v2.7.4/libs/agno/agno/db/postgres/postgres.py>
- <https://openrouter.ai/docs/agent-sdk/overview>
- <https://openrouter.ai/docs/agent-sdk/call-model/tools>
- <https://openrouter.ai/docs/agent-sdk/call-model/tool-approval-state>
- <https://openrouter.ai/docs/agent-sdk/call-model/api-reference>
- <https://openrouter.ai/docs/guides/overview/multimodal/pdfs>
- <https://openrouter.ai/docs/guides/features/plugins/overview>
- <https://openrouter.ai/docs/guides/features/message-transforms>
- <https://openrouter.ai/docs/guides/routing/provider-selection>
- <https://openrouter.ai/docs/guides/routing/model-fallbacks>
- <https://openrouter.ai/docs/api/reference/errors-and-debugging>
