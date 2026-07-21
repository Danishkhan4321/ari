# Ari — the AI work OS for modern teams

> Turn a natural-language request into a verified outcome across your CRM,
> tasks, calendar, email, meetings, files, and team workflows.

Ari is a hosted AI workspace for founders and small teams who want one
assistant to operate their day-to-day work. Its desktop companion adds native
workflows such as meeting capture and dictation, while the safety-first agent
runtime turns an instruction such as *“add these leads, group them by segment,
and follow up next week”* into a traceable sequence of real product
actions—not a chat response that merely claims the work is done.

![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-5B3DF5)
![Runtime](https://img.shields.io/badge/agent%20runtime-Agno%20%2B%20Gemini-4285F4)
![Data](https://img.shields.io/badge/data-PostgreSQL-336791)
![Status](https://img.shields.io/badge/status-active%20development-2EA44F)

## Why Ari

Teams normally split work across a CRM, task manager, email client, calendar,
meeting recorder, knowledge base, and a chat assistant. Ari brings those
surfaces together while keeping the action layer deliberately strict:

- **Natural language in; typed tools out.** Models select a compact set of
  capabilities, but every action is executed through a validated JSON tool
  contract.
- **Truthful completion.** A reply is marked complete only after Ari receives
  the authoritative tool result. Failed calls, missing configuration,
  confirmations, and uncertain outcomes are never presented as success.
- **Safe by default.** Side-effecting and external actions use explicit
  confirmation gates. Repeated tool calls are idempotent, and interrupted
  mutations are recorded as uncertain rather than silently replayed.
- **Your workflow, not a generic chatbot.** Ari understands CRM, teams,
  calendar, email, reminders, files, meetings, and persistent work context.
- **Hosted workspace, desktop companion.** Ari is designed for hosted team
  workflows, with a desktop companion for native capture and productivity
  capabilities.

## What you can do

| Workspace | Examples |
| --- | --- |
| **AI chat & memory** | Ask naturally, continue a session, steer an in-flight task, attach files, and retain durable, versioned facts. |
| **CRM & outreach** | Create and organize contacts and lead groups, manage a pipeline, import data, track follow-ups, and run approved email actions. |
| **Tasks & teams** | Create, assign, edit, and track tasks; run standups, sprints, polls, leave workflows, shared boards, and team updates. |
| **Calendar & email** | Create and manage Google or Microsoft calendar events, draft and send Gmail/Outlook email, and track follow-ups. |
| **Meetings** | Record a meeting from the desktop app, transcribe it, rename speakers, review decisions and action items, and create approved tasks. |
| **Personal productivity** | Set one-off or recurring reminders, receive daily briefings, manage notes, and work in English, Hindi, or Hinglish. |
| **Files & research** | Attach supported documents, preserve source identity across turns, analyze PDFs, and keep session-scoped artifacts confined to the active session. |

## The Ari agent: reliable by design

An agent is useful only when its work is reflected in the product. Ari treats
the model as a planner, not as the authority for business side effects.

```text
Natural-language request
        │
        ▼
Current-turn capability selection
        │
        ▼
Agno + Gemini / Vertex Gemini / OpenRouter
        │  typed FunctionCall only
        ▼
Node execution boundary
  ├─ schema and tenant validation
  ├─ confirmation policy
  ├─ idempotency journal + timeout handling
  └─ CRM / tasks / calendar / email / meeting handlers
        │
        ▼
Authoritative result → product state + truthful response
```

### Guarantees that matter

- **Tenant and session isolation:** every request carries explicit user and
  session identities; dashboard and messaging conversations do not share
  history by accident.
- **Validated execution:** unknown tool fields, unknown tools, missing IDs,
  and bad inputs fail before a business handler runs.
- **Idempotent mutations:** calls are journaled by conversation and tool-call
  ID. A repeated request returns its prior typed result instead of duplicating
  a CRM entry, reminder, or email.
- **Honest interruption handling:** cancellation stops queued work and drains
  any active mutation. If an outcome cannot be verified, it is recorded as
  partial/unknown—not retried blindly or described as done.
- **Provider independence:** Ari mode uses Agno with direct Gemini, Vertex
  Gemini, or OpenRouter. Codex mode uses the user’s direct Codex login through
  the Codex App Server; that login is never converted into an API key.
- **Durable context:** PostgreSQL stores sessions, summaries, append-only fact
  versions, run traces, and tool outcomes. A correction supersedes old memory
  without rewriting history.

Read the complete [agent runtime contract](docs/SHARED-AGENT-RUNTIME.md) for
the execution boundary, file rules, provider modes, and verification suite.

## Architecture

```text
┌───────────────────────────────────────────────────────────────────────┐
│ Ari Desktop (Electron)                                                  │
│  ├─ dashboard: http://127.0.0.1:43101                                  │
│  └─ backend:   http://127.0.0.1:43100                                  │
├───────────────────────────────────────────────────────────────────────┤
│ Next.js workspace  │  Node.js API & action boundary  │  Python Agno     │
│ Chat, CRM, Teams,  │  Auth, tools, policies, jobs,   │  Planner + model │
│ Meetings, Settings │  journals, integrations          │  function calls  │
├───────────────────────────────────────────────────────────────────────┤
│ PostgreSQL: product data, agent sessions, summaries, audit/run state   │
└───────────────────────────────────────────────────────────────────────┘
```

The desktop companion supports native workflows such as meeting capture and
dictation. It uses a single-app lock, so reopening Ari focuses the existing
window rather than starting a second copy.

## Quick start

### Prerequisites

- Node.js 20+
- Python 3.12+
- PostgreSQL
- A Gemini API key, Vertex AI credentials, or an OpenRouter key for Ari mode

### Run Ari

```powershell
git clone https://github.com/Danishkhan4321/ari.git
Set-Location ari
Copy-Item .env.example .env
npm install
npm run setup:agno
npm run migrate
npm run desktop:dev
```

The desktop app opens the primary workspace at
`http://127.0.0.1:43101/chat`.

### Minimum Gemini configuration

Add these values to `.env` before starting the app:

```dotenv
DATABASE_URL=postgres://ari:ari@localhost:5432/ari?sslmode=disable
ARI_AGENT_RUNTIME=agno
ARI_AGNO_MODEL_PROVIDER=gemini
ARI_AGNO_MODEL_ID=your-supported-gemini-model
ARI_AGNO_PYTHON=python
GEMINI_API_KEY=replace-me
APP_BASE_URL=http://127.0.0.1:43100
DASHBOARD_BASE_URL=http://127.0.0.1:43101
```

For Vertex AI, additionally configure `ARI_AGNO_GEMINI_VERTEX=true`,
`GOOGLE_VERTEX_PROJECT`, `GOOGLE_VERTEX_LOCATION`, and Application Default
Credentials or `GOOGLE_APPLICATION_CREDENTIALS`.

For OpenRouter, set `ARI_AGNO_MODEL_PROVIDER=openrouter`,
`OPENROUTER_API_KEY`, and `OPENROUTER_MODELS`.

For Codex, connect the user’s account from Ari Desktop. Ari uses that direct
login through Codex App Server; `OPENAI_API_KEY` is not required for Codex
mode.

> **Attachment storage:** Ari Desktop injects one shared absolute attachment
> directory for the dashboard and backend. For containers or split processes,
> set the same absolute, durable `ARI_SESSION_ATTACHMENT_DIR` in both.

## Verify the product

Run the checks most relevant to the part you changed:

```powershell
# Backend and agent contracts
npm test
npm run test:agent

# Agno worker
npm run test:agno

# Dashboard
npm test --prefix dashboard
npm run typecheck --prefix dashboard

# Desktop shell
npm test --prefix desktop
npm run smoke --prefix desktop

# Evaluation suites
npm run eval
npm run eval:provider-parity
```

Try these real-world prompts once Ari is running:

```text
“Remind Rahul tomorrow at 9 to send the report.”
“Create a follow-up group from this spreadsheet and show me what changed.”
“Actually make that 10.”
“Compare these reports and name every source file you used.”
“Record this meeting, then turn the agreed actions into tasks.”
```

The expected behavior is not merely a helpful sentence: Ari should call the
appropriate typed tool, report a confirmation where required, and reflect the
verified result in the relevant workspace.

## Security and data handling

- Secrets are kept in `.env`, which is ignored by Git; no provider key belongs
  in source control.
- Internal dashboard-to-backend traffic is loopback-only.
- Authentication sessions use server-backed, httpOnly cookies.
- Files receive MIME magic-byte checks, scoped artifact IDs, path-confinement
  checks, and size/hash validation before the agent can read them.
- OAuth token refreshes are concurrency-protected and encrypted at rest.
- The run journal and audit records make agent operations inspectable.

## Repository map

```text
src/          Node.js backend, business services, typed tools, jobs
dashboard/    Next.js product workspace
desktop/      Electron companion, native capture, and dictation
agno_runtime/ Python Agno worker and protocol
migrations/   PostgreSQL migrations
tests/        Backend, runtime, and regression tests
docs/         Architecture, runtime contract, research, and operating notes
```

Useful starting points:

- [Judge/demo guide](docs/DEMO-GUIDE.md)
- [Visual architecture](docs/ARCHITECTURE.md)
- [Product requirements](PRD.md)
- [Architecture guide](DESIGN.md)
- [Agent runtime contract](docs/SHARED-AGENT-RUNTIME.md)
- [Current implementation status and known limitations](STATUS.md)
- [Smoke-test report](SMOKE-TEST-REPORT.md)

## Product status

Ari is in active development. Core chat, CRM, task, team, calendar, email,
meeting, file, and agent-runtime flows are implemented, but some dashboard
surfaces remain read-heavy and some integrations depend on external provider
approval or credentials. See [STATUS.md](STATUS.md) for the candid, detailed
snapshot before treating a capability as production-ready for your deployment.

---

Built for teams that want an AI assistant accountable for outcomes, not just
answers.
