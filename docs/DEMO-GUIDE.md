# Ari demo guide

> A short, reproducible walkthrough for judges, evaluators, and new contributors.

## What to look for

The central claim of Ari is simple: a natural-language instruction should
produce a **verified, visible product change**. During the demo, look for all
three parts:

1. Ari understands an ordinary request.
2. Ari invokes a relevant typed action rather than inventing a result.
3. The change appears in the actual CRM, task, calendar, or meeting workspace.

## Before the demo

1. Configure PostgreSQL and a supported model provider in `.env`.
2. Run migrations and start the desktop application:

   ```powershell
   npm install
   npm run setup:agno
   npm run migrate
   npm run desktop:dev
   ```

3. Open the Chat workspace and ensure the selected agent provider is connected.
4. Use a test workspace/account for any calendar, email, or meeting integration.

## Five-minute walkthrough

### 1. Natural-language action → CRM state

Attach a small CSV/XLSX lead list and ask:

```text
Go through this lead list, make groups like the sheet has them, and show me what you created.
```

**Judge for:** Ari should identify the attachment, create or synchronize the
groups through the CRM action boundary, report concrete counts, and show the
same groups in the CRM workspace. A validation or configuration failure should
be reported clearly—not converted into a success message.

### 2. In-flight steering → preserved context

While a longer task is still running, type:

```text
Also tag the enterprise leads as priority.
```

Use **Steer** in the queued instruction tray.

**Judge for:** the second instruction is retained in the same session, the
existing context remains available, and the next action uses the updated goal.
Independent sessions should remain usable while this run is active.

### 3. Ambiguous follow-up → context-aware action

Then ask:

```text
Actually make that 10.
```

**Judge for:** Ari uses the active session and current workflow context, not a
different user’s history or a global conversation. If the request is genuinely
ambiguous, asking a clarification is the correct behavior.

### 4. Safety gate → approval before impact

Ask for an action that affects another person or sends a message, for example:

```text
Email the priority group with a short meeting invite for tomorrow.
```

**Judge for:** Ari presents an approval preview before a send. It must not
claim that email was sent until the approved tool call returns a verified
result.

### 5. Meeting → durable follow-through

Open **Meetings**, record a short test session, then ask Ari to turn an action
item into a task.

**Judge for:** recording state, transcript/report progress, and task creation
are visible in their respective product areas. Suggested tasks require
confirmation before creating a real assignment.

## Suggested judge scorecard

| Dimension | Evidence to inspect |
| --- | --- |
| Product clarity | README, workspace navigation, and this walkthrough explain a coherent founder/team workflow. |
| Natural-language UX | Prompts can be natural and slightly vague; Ari either acts with context or asks a useful clarification. |
| Execution fidelity | Tool outcomes are reflected in the product—not only echoed in chat. |
| Safety | Confirmation gates, scoped IDs, and cancellation behavior are explicit. |
| Technical depth | Agno/LLM planning is separated from typed Node.js execution and durable PostgreSQL state. |
| Real-world readiness | Hosted workspace flows, desktop-native capabilities, file boundaries, provider configuration, and test commands are documented. |

## Fast verification commands

```powershell
npm run test:agent
npm run test:agno
npm test --prefix dashboard
npm run typecheck --prefix dashboard
npm run smoke --prefix desktop
```

For a deeper assessment of implemented features and known limitations, see
[STATUS.md](../STATUS.md). For architecture details, see
[ARCHITECTURE.md](ARCHITECTURE.md).
