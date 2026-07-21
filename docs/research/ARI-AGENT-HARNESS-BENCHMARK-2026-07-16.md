# Ari Agent Harness Benchmark: Codex and Claude Code

Date: 2026-07-16  
Scope: agent harness, tool calling, planning, context, permissions, execution, retries, errors, progress, and multi-step workflows  
Method: official OpenAI Codex and Anthropic Claude Code documentation, followed by a read-only audit of Ari's current implementation

## Executive conclusion

Ari does not need a wholesale rewrite or a second collection of tools. It already has many of the right building blocks: a bounded agent loop, model routing and escalation, semantic tool retrieval, structured tool schemas, cross-feature context, repeated-call protection, a strict confirmation gate, provider failover, and an end-to-end conversation evaluation harness.

The most important missing layer is a **durable execution harness around the model**. Codex and Claude Code do not rely on a single prompt to provide safety, progress, recovery, and completion. Their harnesses persist session and tool events, evaluate permissions before execution, stream lifecycle updates, separate planning from action when needed, compact context, support interruption/resumption, and verify outcomes before declaring work complete.

For Ari, the highest-value change is therefore:

> Consolidate the two current agentic paths behind one run engine with typed tool metadata, a central policy engine, persistent run/step/event records, structured errors, idempotent execution, verification, and a live event stream.

This can be built incrementally while keeping all current product features and handlers. A credible first production version is realistic in roughly 6–10 engineering weeks for a small team, followed by gradual rollout and evaluation. Reproducing proprietary model behavior, hidden safety classifiers, frontier-model training, or the full infrastructure scale of OpenAI and Anthropic is not realistic or necessary.

## 1. What the official systems actually do

### 1.1 The model is only one component

Claude Code describes its loop as three blended phases: **gather context, take action, and verify results**. Tool results feed the next decision, and the loop course-corrects based on evidence. The harness provides the tools, context management, permissions, execution environment, and session controls around the model. [Anthropic: How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)

Codex's guidance follows the same pattern. It recommends goal-first prompts with Goal, Context, Constraints, and Done-when criteria; difficult or ambiguous work should enter Plan mode or use a maintained execution plan. [OpenAI: Codex best practices](https://learn.chatgpt.com/guides/best-practices)

**Inference for Ari:** better prompting will help, but prompt work alone cannot produce Codex-level reliability. Safety and recovery must be enforced outside the model.

### 1.2 Vague prompts are accepted, then resolved through context and risk

Codex documentation says useful work can begin even when a prompt is imperfect, while clearer context improves reliability. It supports steering an active run and queuing follow-ups rather than forcing the user to restart. [OpenAI: Prompting](https://learn.chatgpt.com/docs/prompting)

Claude Code similarly says users do not need perfect prompts. It explores the environment, chooses tools based on what it discovers, and lets the user interrupt or redirect the current run. Its documentation also acknowledges the boundary: vague prompts work, but precise prompts reduce correction cycles. [Anthropic: How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)

The practical behavior is not “always ask” or “always guess.” It is:

- infer and proceed when the action is reversible, low-risk, and the missing detail can be discovered;
- search available context before asking the user to repeat information;
- ask one focused question when a missing choice changes an irreversible or externally visible outcome;
- state material assumptions in the run record;
- accept steering while work is running.

### 1.3 Planning is adaptive, not mandatory bureaucracy

Codex recommends Plan mode for tasks that are complex, ambiguous, or hard to describe. Its execution-plan guidance treats a plan as a living document with progress, discoveries, decisions, outcomes, validation, idempotence, and recovery. [OpenAI: Codex best practices](https://learn.chatgpt.com/guides/best-practices), [OpenAI: ExecPlans](https://developers.openai.com/cookbook/articles/codex_exec_plans)

Claude Code recommends an Explore → Plan → Implement → Verify workflow for uncertain multi-file work, but explicitly notes that planning adds overhead and should be skipped for small, clear changes. [Anthropic: Best practices](https://code.claude.com/docs/en/best-practices)

**Inference for Ari:** a reminder or CRM lookup should not generate a visible five-step plan. “Prepare me for tomorrow, follow up with every overdue lead, and assign the resulting tasks” should.

### 1.4 Permissions are evaluated before tool execution

Codex separates sandbox access from approval policy. Its configuration supports `read-only`, `workspace-write`, and `danger-full-access` sandboxes, plus approval modes and granular approval categories. MCP servers can also define enabled/disabled tools, per-tool approval modes, and timeouts. [OpenAI: Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), [OpenAI: MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

Claude Code evaluates permission rules with deny before ask before allow. In its SDK, the full order is hooks, deny rules, ask rules, permission mode, allow rules, then a runtime callback. A pre-tool hook can block, request approval, modify input, or add context, but cannot override a deny rule. [Anthropic: Permissions](https://code.claude.com/docs/en/permissions), [Anthropic: Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions)

**Inference for Ari:** confirmation is one kind of permission, not the entire permission system. A central policy engine should decide whether a tool call is allowed, denied, or paused for approval before the handler runs.

### 1.5 Execution is observable as events

Codex non-interactive mode can emit JSONL containing thread, turn, item, completion, failure, and error events, and it can resume a prior session. [OpenAI: Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)

Claude Code exposes lifecycle events before and after tool use, on tool failure, after a tool batch, on permission requests and denials, during compaction, at task creation/completion, and at turn stop/failure. Its headless mode streams newline-delimited JSON and emits explicit retry events containing the attempt number, maximum attempts, delay, and error category. [Anthropic: Hooks](https://code.claude.com/docs/en/hooks), [Anthropic: Headless mode](https://code.claude.com/docs/en/headless)

These events are what allow their interfaces to show “searching,” “running,” “waiting for approval,” “retrying,” and “verified” without exposing private chain-of-thought.

### 1.6 Context is budgeted and compacted

Claude Code persists each message, tool call, and result in a JSONL session transcript. As context fills, it removes older tool output first and then summarizes the conversation. Durable project instructions live outside the chat, skills load on demand, and deferred tools avoid loading every full schema at startup. [Anthropic: How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works), [Anthropic: Memory](https://code.claude.com/docs/en/memory)

Codex likewise supports durable `AGENTS.md` guidance, session history, automatic compaction thresholds, on-demand extensions, subagent context isolation, and resumable sessions. [OpenAI: Codex best practices](https://learn.chatgpt.com/guides/best-practices), [OpenAI: Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), [OpenAI: Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)

### 1.7 Verification is a completion gate

Claude Code's official best practices emphasize giving the agent an objective pass/fail check and iterating until it passes. Its hooks can block stopping when a required check fails. [Anthropic: Best practices](https://code.claude.com/docs/en/best-practices)

Codex execution-plan guidance says validation is mandatory, asks for observable outcomes and expected results, and requires safe retry or rollback guidance for risky steps. [OpenAI: ExecPlans](https://developers.openai.com/cookbook/articles/codex_exec_plans)

For a business operating system, verification is not only tests. It includes reading back the created calendar event, checking the reminder ID and time, confirming a sent message has a provider ID, or confirming a CRM transition actually persisted.

## 2. Ari's current system, as inspected

The following findings refer to the local code on 2026-07-16. The worktree contains uncommitted product work, so these numbers should be treated as a point-in-time audit.

### What is already strong

1. **Bounded multi-step execution.** `src/services/agent-loop.service.js` supports up to 10 steps, a global elapsed-time ceiling, multi-tool turns, tool-result feedback, mid-loop model escalation, and a guard against immediately repeated identical calls.

2. **A second AI SDK-based agentic path.** `src/services/ai.service.js::_chatAgentic` uses validated JSON schemas, a step cap, model routing, tool subsetting, and SDK retry behavior.

3. **Large working capability surface.** `src/services/tool-definitions.js` currently exposes 86 tools across 20 categories. Category pruning, explicit tool hints, essential-tool padding, and `src/services/tool-retriever.service.js` provide several tool-selection strategies.

4. **Good ambiguity policy in the tool layer.** `request_clarification` tells the model to infer read-only actions and ask only when ambiguity affects side effects or an unresolved target. Active workflow hints also help resolve short follow-ups.

5. **Cross-feature grounding.** `src/services/context-builder.service.js` gathers calendar items, tasks, memories, user profile, and entity cards in parallel, fails open, and caps the injected block at roughly 3,000 characters.

6. **Strict approval for outbound actions.** `src/services/confirmation-gate.service.js` uses explicit confirmation phrases, guards against negation, expires stale actions, records audit breadcrumbs, and refuses to let an LLM classification directly authorize a send.

7. **Provider resilience.** The LLM layer has circuit breakers, bounded exponential backoff, provider failover paths, usage tracking, and model escalation.

8. **An existing scenario harness.** `tests/eval/eval-runner.js` replays multi-turn conversations through the actual webhook entry point, suppresses outbound delivery, supports repeated runs, and measures `pass^k` consistency.

### The important gaps

#### A. Two agent runtimes can diverge

There is a custom loop in `agent-loop.service.js` and a separate Vercel AI SDK loop in `ai.service.js`. They have different step limits, tool-selection paths, retry behavior, prompts, timeouts, and result handling. Feature flags determine which path is active. This makes behavior harder to reason about and doubles the surface that must be tested.

**Recommendation:** choose one run engine and place adapters around it. The existing handler implementations remain the tools.

#### B. Tool definitions describe arguments, but not operational policy

The 86 definitions primarily contain name, description, and JSON Schema. They do not consistently declare:

- read-only versus side-effecting behavior;
- risk level;
- required permission scope;
- approval policy;
- idempotency support;
- timeout and retry policy;
- expected result schema;
- postcondition verifier;
- compensating or rollback action;
- user-facing progress label.

Without this metadata, policy lives inside dozens of handlers and prompts. The model cannot be the enforcement boundary.

#### C. Confirmation is strong but not durable execution

The confirmation gate stores an executable closure in memory and only metadata in Postgres. A process restart intentionally loses the executable action and asks the user to repeat the request. That is safe, but it prevents robust pause/resume. It also stores one pending action per user, while a multi-step run may contain several independent approvals or partially completed steps.

**Recommendation:** persist a serializable tool invocation (`tool_name`, validated arguments, version, idempotency key, policy decision, expiry) and reconstruct execution from the registry after approval.

#### D. Tool outcomes are mostly strings

In the main agent loop, the executor wraps most handler output as `{ ok: true, result: "..." }`. A handler that returns an error sentence can therefore look like a success unless it throws. The model sees prose instead of a stable error category and recovery instruction.

**Recommendation:** all tools return a typed envelope such as:

```json
{
  "status": "success | failure | partial | waiting_approval",
  "data": {},
  "error": { "code": "", "category": "", "retryable": false },
  "evidence": [],
  "user_summary": ""
}
```

#### E. The loop is not a durable run

The loop keeps `messages`, `toolsUsed`, and repeated-call state in process memory. It logs a final summary, but there is no persistent run, step, plan, checkpoint, assumption, approval, or event ledger. A timeout or restart cannot reliably resume from the last successful action.

#### F. Retries are provider-oriented, not workflow-oriented

`src/utils/retry.js` handles common transient HTTP and network failures. The agent loop can react to tool errors and blocks one immediately repeated call. Missing pieces include:

- per-tool timeouts;
- `Retry-After` awareness;
- validation/conflict/not-found/permission/transient error classes;
- idempotency keys for mutations and sends;
- partial-success checkpoints;
- bounded retry budgets per step and per run;
- safe resume after restart;
- alternate-tool or re-fetch recovery policies.

The current global timeout is checked between model steps. A single hanging handler can outlive that budget because tool calls do not share an enforced cancellation signal.

#### G. Context is useful but not run-aware

The context builder has good product data, and conversation history can be summarized. However, the agent loop only includes six recent messages, a capped background block, and transient tool messages. There is no structured run scratchpad containing the current goal, accepted assumptions, completed steps, unresolved questions, important IDs, and verification state. Compaction is not explicitly tied to preserving these fields.

#### H. The desktop chat cannot observe tool execution yet

The dashboard chat POST waits for the bot pipeline, and the client polls `conversation_history` every five seconds. It can show messages and a generic typing indicator, but there is no server event stream for plan updates, tool start/success/failure, approvals, retries, or verification. The existing UI can consume such data later without another visual redesign.

#### I. Evaluation checks replies more than execution quality

The current scenario suite is a valuable foundation, but it has six scenarios and mainly matches response text. It does not yet score the chosen tool, arguments, unnecessary clarification, forbidden actions, approval compliance, database postconditions, recovery path, event ordering, latency, or cost.

## 3. Target architecture for Ari

### 3.1 One run engine

Represent every user request as a durable run with the following state machine:

```text
received
  -> understanding
  -> planning (only when needed)
  -> executing
  -> waiting_for_approval | waiting_for_user
  -> executing
  -> verifying
  -> completed | partial | failed | cancelled
```

The model decides the next useful action, but the harness owns state transitions, policy, timeouts, retries, persistence, and completion rules.

Minimum records:

- `agent_runs`: user/workspace, original prompt, inferred goal, status, model, budgets, timestamps;
- `agent_steps`: ordered plan/execution steps, dependencies, status, attempts, tool invocation;
- `agent_events`: append-only lifecycle events for UI, audit, debugging, and replay;
- `agent_approvals`: serializable proposed action, decision, actor, expiry;
- `agent_artifacts`: compact results, evidence, and references to large outputs.

### 3.2 A capability registry, not only function schemas

Keep existing tools but wrap each one with operational metadata:

```ts
type ToolPolicy = {
  capability: string;
  effect: "read" | "write" | "external" | "destructive";
  risk: "low" | "medium" | "high";
  approval: "never" | "when_ambiguous" | "always";
  idempotent: boolean;
  timeoutMs: number;
  retry: { maxAttempts: number; categories: string[] };
  parallelSafe: boolean;
  resultSchema: unknown;
  verify?: string;
  compensate?: string;
  progressLabel: string;
};
```

This metadata should be authoritative. Descriptions remain useful for model selection, but they no longer decide safety.

### 3.3 A central policy engine

Evaluate every proposed call in a deterministic order:

1. hard deny policies;
2. organization/workspace restrictions;
3. tool and resource scope;
4. ambiguity and risk policy;
5. approval requirement;
6. allow.

Suggested Ari defaults:

- reads and searches: allow;
- creating a private note/task/reminder with a resolved target: allow, then show undo where practical;
- modifying shared CRM/team state: allow only when target and change are explicit; otherwise ask;
- sending email/messages, inviting attendees, publishing, deleting, payments, or broad team actions: always preview and approve;
- denied or unavailable tool: return a structured denial to the planner, never silently fall back to an unsafe alternative.

### 3.4 Intent inference for incomplete prompts

Before tool selection, produce a small internal intent contract:

```json
{
  "goal": "",
  "entities": [],
  "constraints": [],
  "desired_outcome": "",
  "assumptions": [],
  "ambiguities": [],
  "risk": "low",
  "needs_plan": false,
  "confidence": 0.0
}
```

Decision rule:

- discover missing facts using read tools and context first;
- proceed on low-risk reversible work when confidence is sufficient;
- log and surface any material assumption;
- ask exactly one question if the unresolved detail changes recipient, scope, money, deletion, publication, or another external side effect;
- never invent a recipient, time, entity ID, or authorization.

This retains Ari's current “read-only requests should not be over-clarified” principle while making it measurable.

### 3.5 Adaptive planning and replanning

Use three paths:

- **direct:** one clear tool call;
- **light plan:** two to four dependent actions held in the run state;
- **full plan:** long or ambiguous work with visible milestones, dependencies, and verification criteria.

After every tool result, the engine should choose among continue, replan, ask, retry, verify, or stop. A plan is not successful merely because every tool returned `success`; it is successful when the goal's postconditions hold.

### 3.6 Structured errors and safe retry

Classify failures before deciding what to do:

| Category | Default behavior |
|---|---|
| validation | Correct arguments once; otherwise ask the user |
| permission | Pause for approval or report denial; do not retry blindly |
| authentication | Ask the user to reconnect the integration |
| not_found | Re-search context, then ask if multiple alternatives remain |
| conflict/stale_state | Re-read the object and replan |
| rate_limit/transient/provider | Bounded exponential backoff with jitter and visible retry event |
| timeout | Cancel the call, retry only if idempotent, otherwise verify state first |
| partial | Checkpoint completed items and offer/resume remaining work |
| business_rule | Explain the rule and propose a valid alternative |

Every side-effecting step needs an idempotency key derived from run, step, tool version, and normalized arguments. Before retrying an ambiguous timeout, query the destination to learn whether the first attempt actually succeeded.

### 3.7 Context layers

Build each model turn from ordered, budgeted layers:

1. stable product and safety instructions;
2. durable workspace/user preferences;
3. current run contract and plan state;
4. active approvals and workflow state;
5. recent conversation;
6. retrieved entity cards and relevant memories;
7. compact summaries of completed tool results;
8. only the relevant tool schemas.

Large outputs should be stored as artifacts and summarized into the model context. Compaction must always preserve the goal, constraints, assumptions, important object IDs, completed/remaining steps, approvals, and verification criteria.

### 3.8 Progress without exposing chain-of-thought

Do not display private reasoning. Emit concise operational events:

```text
run.started
intent.resolved
plan.created
step.started
tool.requested
approval.required
approval.resolved
tool.started
tool.progress
tool.retrying
tool.succeeded
tool.failed
plan.updated
verification.started
verification.succeeded
run.completed
run.failed
```

Each event should include `run_id`, `step_id`, timestamp, safe summary, status, and optional result/evidence reference. Start with Server-Sent Events because execution is primarily server-to-client; add WebSocket control later if live interruption and steering require a bidirectional channel.

The completed UI can render these events as activity cards. It does not need access to hidden reasoning.

### 3.9 Verification contracts

Add a verifier to important tools:

- reminder create/update → read back ID, text, timezone, and scheduled time;
- calendar create/reschedule → fetch event and compare attendees/time;
- message/email send → require provider message ID and recipient match;
- CRM update → reload row and compare changed fields;
- task assignment → reload task, assignee, and due date;
- bulk action → return completed, failed, and unattempted sets.

Verification failures should re-enter the loop as evidence, not be hidden behind a confident final message.

## 4. What is realistic and what is not

### Realistic now

- unify the two loops;
- preserve and wrap all existing handlers;
- add tool policy metadata;
- persist runs, steps, events, and approvals;
- stream progress to the existing chat UI;
- classify errors and add safe retry budgets;
- add idempotency to outbound and mutation tools;
- introduce adaptive planning and verification;
- improve context compaction and just-in-time tool loading;
- expand trace-based evaluations and shadow-test the new loop.

### Difficult but achievable later

- safe parallel execution of independent business actions;
- interrupting a running tool and steering the same run;
- resumable multi-hour background workflows;
- compensating transactions across several SaaS systems;
- specialized planner/verifier subagents for bounded research or review;
- organization-wide policy administration and audit exports.

### Not realistically replicable

- OpenAI's or Anthropic's proprietary system prompts and safety classifiers;
- frontier-model training and post-training that improves native tool judgment;
- their global telemetry, red-team data, and evaluation scale;
- OS/container isolation with the same maturity across every platform;
- perfect intent inference from every vague prompt without occasional clarification;
- raw private chain-of-thought. Ari should expose actions, evidence, assumptions, and results instead.

## 5. Recommended implementation sequence

### Phase 0 — Baseline and contracts (about 1 week)

- Select one agent engine; deprecate the other path behind a compatibility adapter.
- Define the run, step, event, result, error, and approval schemas.
- Instrument the current engine to emit events before changing behavior.
- Add trace capture to the existing evaluation harness.
- Create an initial 30–50 scenario set covering vague prompts, short follow-ups, wrong-tool traps, approvals, retries, partial failures, and multi-step business goals.

Exit criterion: every current agentic turn produces a replayable trace and baseline score.

### Phase 1 — Policy and durable execution (about 2 weeks)

- Add metadata for the highest-traffic 15–20 tools first.
- Introduce the central deny/ask/allow policy engine.
- Persist runs, steps, events, and serializable approvals.
- Enforce per-tool timeouts and cancellation.
- Replace `ok: true + string` wrappers with typed result envelopes.

Exit criterion: a restart can safely resume or cancel a waiting approval, and denied tools cannot execute through another path.

### Phase 2 — Recovery, idempotency, and verification (about 2 weeks)

- Add idempotency keys to sends and mutations.
- Implement the error taxonomy and retry matrix.
- Checkpoint multi-item/bulk work.
- Add verifiers for reminders, calendar, email/message sends, CRM, and tasks.
- Make completion depend on postconditions.

Exit criterion: transient failures recover without duplicate external actions, and partial work can resume from the correct item.

### Phase 3 — Planning, context, and live progress (about 2 weeks)

- Add the internal intent contract and adaptive planner.
- Persist assumptions, dependencies, and plan revisions.
- Add run-aware context compaction and artifact storage.
- Serve the event ledger over SSE and connect it to the existing chat activity UI.
- Add cancel and steer controls once the one-way stream is stable.

Exit criterion: users can see what Ari is doing, approve actions, observe retries, and resume a multi-step run without losing context.

### Phase 4 — Evaluation-driven rollout (continuous, initial 1–3 weeks)

- Run legacy and new orchestration in shadow mode on the same prompts, executing only one.
- Score tool choice, arguments, clarification rate, approval compliance, postconditions, recovery, latency, and cost.
- Roll out by capability and user cohort, not with one global switch.
- Promote tools to the new policy registry only after their scenarios pass consistently.

## 6. Evaluation scorecard

Track at least:

- goal completion rate;
- correct first tool and correct complete tool sequence;
- argument accuracy;
- unnecessary clarification rate;
- unsafe assumption rate;
- approval bypass rate (target: zero);
- duplicate side-effect rate (target: zero);
- recovery success by error category;
- postcondition verification rate;
- partial-work resume success;
- pass^3 or pass^5 consistency for critical workflows;
- p50/p95 time to first progress event and total completion;
- input/output tokens and tool calls per completed goal.

The best primary metric is **verified goal completion without policy violation**, not response quality alone.

## 7. The first concrete build decision

Start by building the event ledger and typed tool-result contract around the current loop. This is the safest first move because it creates visibility before changing autonomy. It will immediately show where Ari selects the wrong tool, loses context, retries incorrectly, or finishes without verifying. That evidence then guides the consolidation of the two runtimes and the permission registry.

Do not begin with multi-agent orchestration. Both official systems use isolated workers selectively, mainly to keep noisy research or verification out of the main context. Ari's central business workflows share CRM, calendar, team, and conversation state, so one durable orchestrator is the better first architecture. Subagents can be added later for bounded research and independent review.

## Official sources

OpenAI:

- [Codex best practices](https://learn.chatgpt.com/guides/best-practices)
- [Prompting](https://learn.chatgpt.com/docs/prompting)
- [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Using PLANS.md for multi-hour problem solving](https://developers.openai.com/cookbook/articles/codex_exec_plans)

Anthropic:

- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices)
- [Configure permissions](https://code.claude.com/docs/en/permissions)
- [Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Hooks reference](https://code.claude.com/docs/en/hooks)
- [Run Claude Code programmatically](https://code.claude.com/docs/en/headless)
- [How Claude remembers your project](https://code.claude.com/docs/en/memory)
- [Subagents](https://code.claude.com/docs/en/sub-agents)

