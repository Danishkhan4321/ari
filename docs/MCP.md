# Ari MCP — your context layer, everywhere

Ari exposes each user's cross-feature context (CRM leads, meeting notes,
tasks, reminders, remembered business facts) as a **Model Context Protocol
server**, so external AI clients — Claude, Cursor, partner agents — can use
Ari as their business-context source instead of re-collecting it.

## Endpoint

```
POST {APP_BASE_URL}/mcp
Authorization: Bearer smcp_…
```

Streamable HTTP, **stateless JSON mode** (single JSON-RPC request/response
per POST; no SSE stream). Supported protocol versions: `2024-11-05`,
`2025-03-26`, `2025-06-18`.

## Getting a token

- **WhatsApp (users):** send Ari `connect claude` — she replies once with
  the endpoint URL and a personal token. `revoke mcp tokens` cuts access.
- **Ops:** `node -r dotenv/config scripts/create-mcp-token.js <phone> [label]`

Tokens look like `smcp_<48 hex>`; only a SHA-256 hash is stored
(`mcp_tokens` table, migration 17). Max 5 active tokens per user.

## Tools

Read-mostly by design — the only write is note-grade memory. Sends, CRM
mutations, and anything irreversible stay inside Ari's confirmation-gated
WhatsApp flows.

| Tool | What it does |
|---|---|
| `ari_search_leads` | Search CRM leads by text and/or stage |
| `ari_lead_timeline` | One lead: fields + facts + linked meetings/emails |
| `ari_search_meetings` | Search meeting notes by text |
| `ari_get_meeting` | Full summary/decisions/action items for a meeting |
| `ari_list_tasks` | Pending tasks |
| `ari_list_reminders` | Pending reminders |
| `ari_search_facts` | Search remembered business facts (entity memories) |
| `ari_entity_card` | Compact cross-feature card for a person/company name |
| `ari_add_fact` | Remember a business fact about a lead/contact (only write) |

## Connecting from Claude

Add a custom connector with the `/mcp` URL; use the token as the bearer
credential. Then ask things like *"check Ari — what's the latest with the
BlueFin deal?"* or *"pull the decisions from my last meeting with Meera"*.

## Smoke test

```bash
curl -s -X POST "$APP_BASE_URL/mcp" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
