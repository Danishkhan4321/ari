# DESIGN — Ari Architecture

> The 30-min read for a new contributor. How the system is shaped, why, and where the bodies are buried.

## 1. High-level shape

```
                ┌─────────────────────┐
                │ WhatsApp user phone │
                └──────────┬──────────┘
                           │
                  Meta Cloud API
                           │
                           ▼
            ┌─────────────────────────────┐
            │  ARI API  (127.0.0.1:43100) │
            └────────────┬────────────────┘
                         ▼
            ┌─────────────────────────────┐
            │  BOT  (Express, PM2)        │       Cron jobs
            │  src/index.js               │ ───── reminders, briefing,
            │  port 3000                  │       sprint, standup, etc.
            └──┬────┬────┬────┬───────────┘
               │    │    │    │
               ▼    ▼    ▼    ▼
      Postgres  Redis  Gemini  Meta/Google/etc.
      (Supabase)(opt)  (LLM)   (third-party APIs)
                         ▲
                         │
            ┌────────────┴────────────────┐
            │  DASHBOARD (Next.js, PM2)   │
            │  dashboard/ • port 3001     │
            │  Ari desktop dashboard      │
            └─────────────────────────────┘
                         │
                         └── (Cloudflare proxy in front)

Manual meeting recording:
Desktop capture (system + microphone) -> durable local file -> loopback API
  -> private retained object storage -> AssemblyAI -> canonical report
  -> Meetings page transcript, report, speaker rename, and playback
```

Production Ari services can run in a hosted environment. The desktop companion uses loopback-only endpoints for its native workflows, while PostgreSQL and connected services remain independently deployable.

## 2. The four code surfaces

| Surface | Path | What it does |
|---|---|---|
| **Bot** | `src/` | Express server, message processing, cron jobs, all business logic |
| **Dashboard** | `dashboard/` | Next.js app, web UI, magic-link auth, talks to bot via internal API |
| **Desktop** | `desktop/` | Electron companion, durable meeting capture, and native-service lifecycle |
| **CI/CD** | `.github/workflows/` | Auto-deploy to EC2 on push to main + rollback |

## 3. Bot architecture

### Entry point: `src/index.js`

Order of boot:
1. Sentry init (must be first)
2. Env validation (`utils/env-check.js`) — fails loudly if `ENCRYPTION_KEY` malformed, etc.
3. Postgres pool connect with timeout
4. Express setup + security middleware (HSTS, helmet, rate limits)
5. Routes: `/webhook` (Meta), `/auth/google`, `/auth/microsoft`, `/webhook/razorpay`, `/webhook/internal/dashboard-message`
6. Static `/assets`
7. Inngest (durable functions, optional)
8. ~17 background cron jobs
9. Heartbeat (keeps Gemini TLS + Postgres warm — see "Cold-start" below)
10. Graceful shutdown handler

### Webhook flow

```
Meta → POST /webhook
  ↓
verifyMetaSignature (HMAC-SHA256 over raw body)
  ↓
webhook.controller.handleMessage
  ↓
  • bot detection (rate, burst, message patterns)
  • per-user lock (one message at a time per user)
  • input sanitize (RTL strips, length cap, XSS safety)
  • dedup (Postgres-backed, survives Meta 24h retry)
  ↓
Voice? → Sarvam/Whisper → text
Image? → handleImage (vision API)
Document? → MIME magic-byte validation → handleDocument
  ↓
Text path:
  • cold-start welcome check (first-ever message)
  • post-payment onboarding intercept
  • delegated-task text reply intercept
  • briefing CTA intercept
  • language detect (async, non-blocking)
  ↓
intent detection (aiService.detectIntent)
  → Single LLM tool call selects ONE tool + extracts params
  → tool-definitions.js defines ~90 intents
  ↓
checkFeature(intent) → plan gate → upgrade prompt if blocked
  ↓
executeIntent → routes to handler
  → src/handlers/*.handler.js (Phase 1+ handlers, dynamically registered)
  → OR webhook.controller's giant switch for legacy intents
  ↓
response → translation (if non-English) → messagingService.send
  ↓
WhatsApp adapter → Meta Cloud API
```

### The giant controller

**`src/controllers/webhook.controller.js` is 11k lines.** It evolved over time and is being carved out into `src/handlers/` per feature. Architectural debt — see STATUS.md for plans to split it further.

Key pattern: every intent that has a `*.handler.js` in `src/handlers/` is dispatched via `handler-registry`. The legacy intents still live in the controller's `executeIntent()` switch.

### Service layer (`src/services/`)

~100 service files. Organized by feature, not layer. Each service owns its tables (with `ensureSchema()` lazy-create — see STATUS for schema-drift note).

The most important ones:

| Service | Owns |
|---|---|
| `ai.service.js` | Tool-call orchestration, intent detection, chat fallback |
| `llm-provider.js` | Multi-vendor LLM router with circuit breakers |
| `reminder.service.js` | Reminder parsing (Hindi/English/Hinglish + absolute dates + tomorrow override) |
| `subscription.service.js` | Plans, quotas, `checkFeature` gate, team-member exemption |
| `manual-meetings/` | Private recording retention, AssemblyAI transcription, reports, recovery |
| `gmail.service.js` | OAuth, send/reply/threading, bulk send, follow-up |
| `calendar.service.js` | Google Calendar CRUD and reminders |
| `standup.service.js` | Standup configs + responses + alignment analysis |
| `sales.service.js` | Sales lead CRM (pipeline, stages, deal value) |
| `mem0-memory.service.js` | Semantic memory via Mem0 |
| `context-builder.service.js` | Per-turn context (memories + recent activity + user profile) |
| `audit-log` (utils) | Append-only log of sensitive actions |

### Plan / permission system

```
checkFeature(userPhone, intentType) → { allowed, upgradeMsg? }
```

`FEATURE_PLAN` map in `subscription.service.js` defines minimum plan per intent.

Plan ranks: `free(0) < cub(1) < pack(2) < alpha(3)`. Admin phones (env var) get alpha.

**Team-member exemption (important):**
A whitelisted set of intents (`standup_response`, `poll_vote`, `team_availability`, `leave_manage`) lets a Free user use them IF they're listed as a team member of a paying admin. The admin pays for the seat; the member can participate (reply, vote, apply for leave) but cannot create (no admin actions).

This was the headline bug fix of May 2026 — before it, paid admins set up team workflows but Free invitees got upgrade-walled when trying to participate.

### Cron jobs (`src/jobs/`)

17 jobs:

| Job | Schedule | What |
|---|---|---|
| reminder | every 30s | fire due reminders |
| task | every minute | follow-up nudges on open tasks |
| calendar-reminder | every minute | pre-meeting pings (with cross-table dedup vs manual reminders) |
| standup | every minute (questions), 5min (digests) | per-user-tz dispatch |
| scheduled-email | every minute | send queued emails |
| focus | every 30s | session timeout |
| habit | every minute | habit nudges (exact HH:MM match) |
| follow-up | every minute | contact follow-up reminders |
| sprint | every 15min | per-admin-tz daily updates + end warnings |
| incident | 2/5min | escalation |
| poll | every 5min | close-time |
| anthropic-cache-warmer | every 4min | adaptive cache warming |
| auto-label | (disabled pending CASA) | Gmail label inference |
| reply-tracker | (disabled pending CASA) | watch for inbound replies |
| daily-briefing | every 15min | per-user-local-time morning briefing |
| user-profile | weekly Sun 03:00 | infer user profile from Mem0 |
| daily-maintenance | daily 03:30 | prune `processed_messages` etc. |

Every job uses an `isRunning` mutex. Reminder + maintenance jobs also take a Postgres advisory lock to be safe across PM2 reload.

### Heartbeat (cold-start protection)

Every 60s, the bot pings Gemini (1-token "ping" via Flash-Lite) + Postgres (`SELECT 1`). Keeps TLS + connection pool warm. Cost ~$0.15/month. Without this, first message after idle paid 7-10s of TLS reconnect.

### Security

- WhatsApp webhook → HMAC-SHA256 over raw body (`META_APP_SECRET`)
- Dashboard internal bridge → loopback-only + shared secret with timing-safe compare
- Desktop meeting API → loopback-only, launch-scoped token, timing-safe comparison
- OAuth tokens encrypted at rest (AES-256-GCM, `ENCRYPTION_KEY` validated at boot)
- Audit log on sensitive actions (admin bypass, plan changes, signature failures)
- Per-user rate limits (BoundedMap, 5min-1h TTL buckets)
- Bot behavior detection (rapid-fire, constant-timing flags)
- IDOR audits — every UPDATE/DELETE scoped by user_phone
- MIME magic-byte validation on document uploads
- Voice transcription gated to 10/month for free users (cost control)

## 4. Dashboard architecture

### Stack
- **Next.js 14 App Router** (server components + client components)
- **Tailwind** (custom design tokens for "brutalist" look)
- **Postgres** via `pg` (direct connection, same DB as bot)
- **TypeScript strict**

### Routes (`dashboard/app/`)

```
/                     → home (Folk-style minimal, KpiStrip + section cards)
/login                → magic-link claim
/auth                 → claim handler
/chat                 → live chat with bot (polls conversation_history)
/crm                  → sales pipeline + contacts
/reminders            → list / filter / snooze
/tasks                → assigned / mine / delegated
/inbox                → scheduled emails
/meetings             → recordings, transcripts
/notes                → notes & knowledge base
/team                 → members, standups, polls, leave
/productivity         → habits, focus, expenses
/settings             → account, integrations, plan
/onboarding           → first-time setup flow
```

### Auth flow

```
WhatsApp user says "open dashboard"
  ↓
Bot inserts row in link_codes (platform='web', expires 5min)
  ↓
The local app opens: http://127.0.0.1:43101/auth?code=ABC123
  ↓
User clicks → /auth client component calls POST /api/auth/claim
  ↓
claim → atomic UPDATE link_codes SET used=true ... RETURNING user_id
  ↓
session created in dashboard_sessions, httpOnly+sameSite cookie set
  ↓
Redirect to /
```

Sessions are server-backed (not JWT) so logout invalidates immediately. 30-day expiry.

### Dashboard → Bot bridge

When user sends a message via the dashboard chat:

```
Dashboard /api/chat/send
  ↓
sendThroughBot() POSTs to bot's /webhook/internal/dashboard-message
  ↓
Bot processes via handlePlatformMessage (same path as WhatsApp)
  ↓
Bot writes BOTH user message and reply to conversation_history
  ↓
Dashboard /api/chat/messages polls every 5s, picks up new rows
```

To avoid double-pinging the user, `messaging.service.js` has a `dashboardMode` BoundedMap. When a dashboard turn fires, the per-user flag is set for 60s. The WhatsApp send path checks the flag and skips the push. (Bot uses `sendThroughBot`'s `source: 'dashboard'` tag to set it.)

## 5. Manual meeting recording architecture

The desktop app owns capture; the backend owns retention and processing.

1. **Record Meeting** starts an Electron-owned capture session after an explicit user gesture.
2. Windows combines display-audio loopback and microphone tracks. macOS uses the bundled ScreenCaptureKit helper with Screen Recording and Microphone permissions.
3. Capture chunks and a session manifest are written atomically; a finalized file remains available for upload retry in the active desktop session.
4. Stop finalizes the local recording and streams it to the loopback-only desktop API using the launch-scoped internal token and authenticated user identity.
5. The processor normalizes audio with FFmpeg, uploads it to private retained object storage, and submits it to AssemblyAI with speaker labels and language detection.
6. A structured LLM pass generates the summary, decisions, action items, suggested tasks and assignees, topics, open questions, and complete report.
7. The Meetings page polls processing state and shows authenticated playback, transcript, suggestions, and report.

Canonical transcript segments and report references use stable speaker IDs. A speaker rename transaction updates the display-name map and rematerializes every transcript and report field. Suggested tasks remain proposals until the user explicitly confirms them through the existing task workflow.

Startup recovery resumes incomplete backend stages; the retained original recording is never deleted as part of normal processing.
## 6. Data model

Primary tables (most have `user_phone` as the user scoping key):

```
users                       — onboarding state, language, name
subscriptions               — plan, status, payment ids, lifecycle timestamps
                              unique partial index on (user_phone) WHERE status='active'
user_settings               — timezone, briefing prefs, free quota counters

teams                       — admin_phone → member_phone map
contacts                    — name, phone, notes, category (+ enrichment cols TBD)
sales_leads                 — name, email, company, stage, deal_value, source, ...

reminders                   — message, time, recurrence, status
tasks                       — description, assignee, follow-up cadence, completion
sprints + sprint_items      — sprint scope + items with story points
standup_configs + standup_responses
polls + poll_votes
leave_requests
incidents
follow_ups
notes / knowledge_base / reading_list / shared_boards
focus_sessions / habits / habit_logs / expenses

conversation_history        — every user + bot message (for context window)
processed_messages          — Meta webhook dedup (25h retention)

calendar_events             — synced from Google
calendar_reminders          — pre-meeting pings
google_tokens / microsoft_tokens — OAuth tokens (encrypted)
linked_accounts             — multi-account linking (mostly legacy)

meeting_recordings          - retained audio, canonical transcript/report, processing checkpoints
meeting_minutes             — structured minutes (auto-linked to KB)

dashboard_sessions          — cookie-backed sessions
link_codes                  — magic-link auth tokens

audit_log                   — append-only, sensitive actions
sent_email_log              — every Gmail send tracked
```

## 7. CI/CD

`.github/workflows/`:

- **deploy-bot.yml** — fires on push to main if `src/`, `scripts/`, `package*.json`, or `ecosystem.config.js` changed
- **deploy-dashboard.yml** — fires on push to main if `dashboard/**` changed
- **rollback.yml** — manual `workflow_dispatch`, restores last-known-good snapshot

Each deploy: snapshot current state → rsync new source → install → build (dashboard) → reload PM2 → health probe (HTTP + PM2 status) → auto-rollback on failure.

`DEPLOY_SSH_KEY` GitHub Secret authenticates Actions to the EC2 box.

## 8. Observability

- **Sentry** — errors + breadcrumbs
- **Local logs** — `logs/` for the backend and the desktop session-log directory for isolated chat traces
- **Pino structured logs** — JSON, queryable
- **Audit log** — Postgres-backed for sensitive actions
- **Health endpoint** — `GET /health` returns 200 (healthy) or 503 (degraded — DB down)
- **Meeting recovery** — backend processing checkpoints resume incomplete transcription and report work after restart

## 9. Resilience

- **Circuit breakers** (opossum) around OpenAI / Gemini / Anthropic / Bedrock / Tavily / Gmail / OAuth refresh
- **withRetry** on every outbound message send
- **BoundedMap** caches with max-size + TTL (no memory leaks)
- **graceful shutdown** order: HTTP close → messaging → realtime → pg-boss → pool.end() → Sentry flush
- **Postgres advisory locks** on reminder + daily-maintenance crons (cross-process safe)
- **Rollback snapshots** on every deploy

## 10. Conventions

- Every UPDATE/DELETE scoped by `user_phone`
- All HTTP outbound: 30s timeout
- All `BoundedMap` (max + TTL); never raw `new Map()` for user data
- All cron jobs: `isRunning` mutex
- Schemas lazily created in services (`ensureSchema()` pattern) — yes, this is technical debt, see STATUS.md
- Module-level `require('audit-log')` for any sensitive action

## 11. Where to start reading

If you're new and want a quick path:

1. `src/index.js` — see boot order
2. `src/controllers/webhook.controller.js` lines 1071–1300 — see message processing flow
3. `src/services/subscription.service.js` — see the plan/permission system
4. `src/services/reminder.service.js` — see a complete feature end-to-end
5. `dashboard/app/page.tsx` and `dashboard/app/crm/page.tsx` — see the dashboard pattern
6. `.github/workflows/deploy-bot.yml` — see the CI/CD pattern

Then come back to STATUS.md to see what's actively being worked on.
