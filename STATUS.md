# STATUS — What's implemented, what's pending

> Honest snapshot of the codebase as of June 2026. Updated after a 4-pass deep audit.

## ✅ Working in production (verified)

### Personal productivity
- One-off + recurring reminders with full English/Hindi/Hinglish parsing
- "Tomorrow" override + absolute-date parsing ("19th May", "next Friday", "Dec 25", "parso")
- Past-date rejection with specific user message
- Voice notes → transcribe (Sarvam → Whisper fallback)
- Free-tier monthly quotas: reminders (5), searches (12), AI chats (30), voice (10)
- Web search via Tavily + Exa
- Auto-language detection + reply translation
- Memory (Mem0) with semantic search
- Daily briefing per-user-local-time

### Team workflows
- Standup configs + responses + alignment analysis
- **Team-member exemption** — Free invitees can reply to standups, vote in polls, apply for leave, see team availability, even when their admin is on a paid plan
- Standup digest broadcast with 100ms pacing (WhatsApp rate-limit safe)
- Sprints with story points + velocity
- Sprint end → moves incomplete items to `backlog` status
- Polls with vote dedup
- Leave requests + approvals
- Shared boards with ownership-checked task assignment
- Team analytics digest (with corrected `created_at` SQL)

### Sales / CRM
- Sales leads pipeline (`sales_leads`) with stages: new → contacted → replied → meeting → proposal → negotiation → closed_won/lost
- Contact management with phone masking on export
- Bulk email (recipient-leak bug fixed)
- Follow-up tracking
- Dashboard CRM section (pipeline kanban + contacts table)

### Meetings
- User-controlled **Record Meeting** flow inside the existing Meetings page
- Windows system-audio loopback plus microphone mixing
- macOS ScreenCaptureKit helper with Screen Recording and Microphone permissions
- Atomic local capture manifests and retryable finalized uploads
- Private retained recording storage and authenticated playback
- AssemblyAI transcription with neutral speaker labels
- Summary, decisions, action items, task/assignee suggestions, and complete report
- Atomic speaker rename across transcript and every generated artifact
- Suggested tasks require explicit confirmation before creation

### Calendar + Email
- Google Calendar + Microsoft Calendar CRUD
- Calendar/reminder cross-table dedup (±2min window)
- Gmail send + thread + follow-up
- Bulk email
- OAuth token refresh with concurrent-refresh lock + AES-256-GCM encryption

### Subscriptions
- Razorpay payment + welcome retry (3× exponential backoff)
- Lifecycle: subscription.charged, cancelled, halted, completed, expired, refunded all handled
- Transactional create with old-row demotion
- Partial unique index on `(user_phone) WHERE status='active'` with pre-dedup safety
- Plan downgrade graceful pause (standup cron, briefing, etc. check plan at send time)
- Audit log on every plan change

### Dashboard
- Magic-link auth via WhatsApp ("open dashboard")
- Server-backed sessions (30-day cookies, httpOnly + sameSite)
- All ~15 sections: chat, crm, reminders, tasks, inbox, meetings, notes, team, productivity, settings, onboarding
- Chat polling (5s) with conversation_history
- Bot bridge with loopback-only enforcement
- /api/auth/claim rate-limited (5/h per IP)
- Dashboard-mode flag prevents double-pinging WhatsApp during dashboard chat

### Infrastructure
- Cron `.stop()` on PM2 reload (clean shutdown)
- Postgres-backed message dedup (25h retention, beats Meta's 24h retry window)
- Fallback fingerprint dedup for messages without messageId
- Anthropic + Bedrock circuit breakers
- Memory trunk weekly prune (200/user cap)
- Daily-maintenance cron at 03:30 UTC
- `ENCRYPTION_KEY` length validated at boot
- Heartbeat (Gemini + Postgres every 60s) keeps cold-start short
- Focus mode actually mutes daily briefing
- Sprint cron uses per-admin local time

### Security
- WhatsApp signature verification (timing-safe HMAC)
- Meeting callback signature verification
- Internal bridge loopback-only
- Admin debug key timing-safe compare
- MIME magic-byte validation on documents
- Voice transcription gated by quota
- IDORs fixed: task_stopfollowup, KB updateArticle, image DELETE, follow-up markReminderSent, shared-board assignTask, sprint updateItemStatus, reminder cancel (5 sites)
- Per-user processed-message dedup persists across PM2 reload
- Audit log on: admin_bypass, plan_change, plan_renewal, plan_cancelled, plan_refunded, meeting_launch, callback_unsigned, callback_invalid_sig

### CI/CD
- Auto-deploy bot on push (~30s)
- Auto-deploy dashboard on push (~3min)
- Automatic rollback on failed health probe
- Manual rollback via `workflow_dispatch` (Actions → Rollback)
- Per-deploy snapshots (`src-rollback/` and `.next-rollback/` on EC2)

## 🚧 Pending / known limitations

### Big features not yet shipped
- **Email enrichment** — designed (see commit history) but not built. Plan: Tomba PAYG (~$0.04/find), `enrichment.service.js` + `enrich_contact` intent + `contacts.email` column
- **Organization seats** — currently plan is per-phone. Tactical exemption whitelist works; structural per-org migration is the proper long-term fix
- **Notification preferences** — quiet hours, per-category mute. No UI yet
- **Inbound email → task** automation
- **Re-upgrade resume flow** — when user re-subscribes after lapse, old reminders fire as-is; no "resume these?" check
- **Meeting consent UI** — in-call "I'm recording" announcement
- **`task_member_done`** split intent — free invitees currently can't mark assigned tasks done unless they hit the button
- **Unified search** across memories / notes / KB / reading list

### Technical debt
- **`webhook.controller.js` is 11k LOC** — needs carving into more `src/handlers/*.handler.js` files. About half the intents are already split out; the other half still live in the controller's giant `executeIntent` switch
- **~38 tables use lazy `ensureSchema()`** instead of formal migrations. Drift risk. The `migrations/` dir exists but is sparse
- **Dashboard styles** — Brutalist tokens + Folk-style minimal coexist (incremental redesign); should converge
- **No ESLint in dashboard** — TypeScript strict catches a lot but linting would catch more
- **No automated end-to-end tests** — there are unit-ish tests in `scripts/test-*.js`, no Playwright/Cypress
- **`.next-rollback` is a single generation** — only the last good build; no full history
- **No org-level audit trail** — `audit_log` is global, no per-org separation yet

### Disabled in production (waiting on external)
- **Reply tracker** (`reply-tracker.job`) — needs `gmail.readonly` scope which requires CASA security audit
- **Auto-label** (`auto-label.job`) — same CASA dependency

### Operational gaps
- **EC2 worker secrets** are injected via cloud-init user-data (visible via IMDS). Move to IAM instance profile + Parameter Store
- **No deploy approval gate** — push to main = live. Suitable for small team; would need PR review for larger team
- **Cloudflare config** is manual — DNS/SSL/page rules not in code
- **Backup strategy** — Supabase has its own backups; no separate snapshots for the EC2 box other than the May 2 tarball

### Known production noise (not bugs)
- Recurring `Inbox summary error [403]: Insufficient Permission` — Gmail scope issue, CASA pending
- Occasional `[Mem0] Search error: 400 Request contains an invalid argument` — Mem0 transient
- `[FastPath] Index build failed: 429` from Gemini rate limit (rare)

## 🐛 Known bugs / things to watch

- **Mem0 init** sometimes fails with `Cannot find module 'ollama'` at startup — non-fatal, Mem0 lazy-inits on first request
- **Slow Postgres queries** (~6s) seen during occasional Supabase contention spikes; not a code issue but worth noting
- **Within-team privilege escalation** — `_resolveAdminPhone` returns admin_phone for any team member. A free team member can perform admin actions ON THEIR OWN TEAM (incidents, KB articles, sprints). Cross-team is blocked. Whether this is a bug depends on your trust model
- **Dashboard sections are mostly read-only** in v1 — many are stubs that show data but don't fully implement write paths yet (CRM is fullest)
- **macOS real-device capture** requires a signed helper and must be verified on release hardware

## 🔭 Roadmap priority order (suggested)

1. **Email enrichment via Tomba** — high value, tractable (~3 hours of work)
2. **task_member_done split intent** — closes a UX gap for free team members
3. **Carve email handlers out of webhook.controller** — biggest single LOC win
4. **Migration files for the ensureSchema tables** — eliminates drift risk
5. **End-to-end Playwright tests** for the top 5 user journeys
6. **Notification preferences** — first paid retention feature
7. **Organization seats** — the strategic per-team-plan change
8. **Re-upgrade resume flow**

## 📚 Files to inspect for each topic

| Topic | Start here |
|---|---|
| Add a new intent | `src/services/tool-definitions.js` + `src/handlers/handler-registry.js` |
| Add a new dashboard section | `dashboard/app/<section>/page.tsx` + `dashboard/lib/<section>.ts` |
| Add a new cron job | `src/jobs/<name>.job.js` + wire in `src/index.js` |
| Change plan gating | `src/services/subscription.service.js` (FEATURE_PLAN, TEAM_MEMBER_EXEMPT) |
| Tweak reminder parsing | `src/services/reminder.service.js` (parseWithAI + extractAbsoluteDate) |
| Add a payment event | `src/routes/razorpay.routes.js` + `subscription.service.handle*` |
| Change meeting recording | `desktop/src/meeting-capture/` + `src/services/manual-meetings/` + `dashboard/app/meetings/` |
| Tweak CI/CD | `.github/workflows/*.yml` |

## 📞 Hard questions / get help

- **`webhook.controller.js` is intimidating** — yes, it's 11k lines. Search for the intent name in `tool-definitions.js` to find the handler, then jump to it. Don't try to read the whole controller top-to-bottom
- **Why so many services?** — feature-oriented; each owns its own tables. Adding a feature usually means a new service + a handler, not editing 5 files
- **Can I rewrite X?** — yes, but read DESIGN.md first to understand why a thing looks weird. Often the weirdness is paying for a real constraint (concurrency, cost, WhatsApp rate limits, etc.)
- **What's the source of truth for X?** — Postgres. Always.

## Session changelog (May–June 2026, last big sweep)

Four audit passes shipped ~150 fixes across batches A through H:

- **A** — Security: AWS callback HMAC, internal bridge loopback, ENCRYPTION_KEY validation, dashboard claim rate limit
- **B** — Team workflows: free-tier team-member exemption, team-analytics SQL fix
- **C** — Meeting + calendar + focus + sprint
- **D** — Operational: dashboard ↔ WhatsApp dedup, cron .stop, memory prune
- **E** — Roadmap: Whisper fallback, audit log, KB auto-link, cold-start welcome
- **F** — Second-pass IDORs + payment lifecycle + resilience
- **G** — processed_messages cleanup cron + subscriptions pre-dedup
- **H** — Two more IDORs (shared-board, sprint), /assets 404 cleanup

See git log for the full commits with rationale.
