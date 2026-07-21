# Database Migrations

This directory holds database migrations managed by [node-pg-migrate](https://github.com/salsita/node-pg-migrate).

## Why migrations instead of `CREATE TABLE IF NOT EXISTS`

Previously Ari had ~117 inline `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE IF NOT EXISTS` calls scattered across 30 service files. That pattern has several problems:

- **No rollback path** — you can't undo a schema change
- **Schema drift between envs is invisible** — dev and prod can silently diverge
- **Races on startup** — two concurrent first-calls can both run DDL
- **No history** — new devs have no single source of truth for the schema

Migrations solve all of these: every change is a file in git, with `up` and `down` functions, and one command (`npm run migrate`) brings any env up to date.

## Usage

```bash
# Apply all pending migrations
npm run migrate

# Roll back the most recent migration
npm run migrate:down

# Create a new migration (generates a timestamped file)
npx node-pg-migrate create my-migration-name
```

## Conventions

- Every schema change (new table, new column, new index) gets its own migration file
- Name them `NNN_short-description.js` (timestamp prefix auto-generated)
- Always write both `up` and `down` — even if `down` is just a note explaining irreversibility
- Never edit a migration after it's been deployed to prod — write a new one instead

## Environment

Uses `DATABASE_URL` from `.env`. To target staging/prod, set it before running:

```bash
DATABASE_URL=postgresql://... npm run migrate
```

## Baseline

Migration `1_baseline_schema.js` represents the schema as it existed when migrations were introduced. It's idempotent (uses `IF NOT EXISTS`) so running it on an existing DB is safe — it will simply no-op on tables that already exist.

Subsequent migrations DROP the `IF NOT EXISTS` guards because the migration runner tracks which migrations have already applied.

## Agent data

- `18_agent_run_ledger.js` records durable run events and typed tool outcomes.
- `19_chat_sessions.js` adds tenant-scoped dashboard sessions, idempotent
  submissions, current-turn attachment rows, and session-aware run/history
  links.
- `20_openrouter_agent_state.js` journals conversation locks and idempotent tool calls shared by the OpenRouter and Agno runtimes.
- `21_session_scoped_confirmations.js` prevents a confirmation in one dashboard
  session from authorizing work staged in another.
- `22_openrouter_file_analysis_cache.js` stores tenant/session-scoped parsed-PDF
  state and annotations for follow-up analysis without reparsing the bytes.
- Agno creates its own session, memory, metrics, and evaluation tables using the configured `ARI_AGNO_*_TABLE` names and the same `DATABASE_URL`/schema.
- `32_provider_neutral_agent_summaries.js` stores a tenant/session-scoped,
  credential-redacted handoff summary so fresh Gemini/Agno and direct Codex
  threads inherit canonical context without sharing provider-owned state.
- `29_versioned_agent_memory.js` adds append-only fact versions. Explicit corrections supersede older values, expired facts stay suppressed, and the legacy `memory_trunk` remains only a current-value projection during migration.
- `30_persistent_local_user_files.js` records the confined local path, byte size, and SHA-256 digest used when object storage is unavailable, so WhatsApp artifacts remain readable after a process restart.
- `31_standup_timezone.js` stores the IANA timezone used to evaluate each recurring standup schedule instead of treating every configured time as UTC.
