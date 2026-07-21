# NLU / Intent-Routing Fixes — July 2026

**Problem:** the bot behaved like a keyword matcher on casual WhatsApp messages
(typos, slang, Hinglish, short replies) — wrong tool picks, wrong responses,
and broken conversation flows. This is the record of what was actually wrong,
what changed, and how to test it.

---

## Root causes (as found in the code + our own eval data)

The LLM was never the problem — it was wrapped in three layers of keyword
matching, and then prompted to guess:

1. **Keyword tool-subsetting hid the right tool from the LLM.**
   `classifyCategoryFromKeywords()` (regex, first-match-wins) picked a category
   and the intent LLM saw only ~20 tools from it. A wrong regex hit meant the
   correct tool was *not on the menu at all* ("help me write an email…" →
   `account` category → `send_email` absent). Padding was file-order, so which
   tools survived was an accident of their position in a 1,985-line file.
   `test/GAP-REPORT.md` already identified this as failure mode #1 (35% of
   failures) — and the historical fix pattern was "widen the regex".

2. **The semantic fallback router still mapped short replies to the REMOVED
   visa feature.** `"send all"` → category `visa` → an empty category subset.

3. **The intent prompt itself codified keyword matching.** "LEAD-VERB ROUTING —
   THE FIRST VERB DETERMINES THE TOOL" (Hinglish is verb-final; casual messages
   are verbless), single-word ALWAYS mappings, and literally: *"it's OK to be
   slightly wrong"*. There was no clarification tool, so guessing was the only
   option the model had.

4. **Messages ≤2 chars never reached intent detection** — `"1"`, `"2"`, `"ok"`
   were dropped to chat mode even when the bot had just shown a numbered list.

5. **Tool-path turns were NEVER saved to conversation history.** Only
   `aiService.chat()` saved messages. Every reminder/calendar/email exchange
   left no trace, so follow-ups ("change it to 6pm", "the 2nd one") arrived
   with empty context and were treated as brand-new queries.

6. **Pre-LLM regex intercepts hijacked short replies**: bare `"stop"` was
   consumed by a retired recording shortcut; `"skip"/"more"/"status"` by the briefing
   handler with no recency check; `"done"/"nope"` by the delegated-task
   handler even while another flow was waiting for that answer.

7. **The confirmation gate prefix-matched yes/no**: `"ok, don't send it yet"`
   SENT the email (`^ok` → yes); `"yess"`, `"okk"`, `"han bhej de"` matched
   nothing and looped a nag; any unmatched short message was swallowed for up
   to 30 minutes.

8. **A scoping bug meant the per-user lock was never released** (`const
   message` inside `try`, guard in `finally` referenced it out of scope), so
   every rapid follow-up spin-waited 15s.

9. **Zod validation enums had drifted from tool definitions** — correct LLM
   calls (`manage_tasks action="assign"`, `manage_notes action="save"`) failed
   validation; 15 registry keys pointed at tools that don't exist.

## What changed

### Intent detection (`src/services/ai.service.js`)
- **v3 intent prompt (default).** Intent-first reading of casual text, explicit
  clarification policy, no lead-verb decree, no "OK to be wrong". Keeps the
  proven guardrails (web_search for realtime data, anaphora priorities/vetoes,
  positional-reference resolution, Hinglish anaphora, draft-edit flow).
  Rollback: `INTENT_PROMPT_VERSION=v1` or `v2`.
- **Short messages reach the LLM when history exists.** `"2"` after a list is
  a selection, not noise (still dropped when there is no context at all).
- **Short follow-ups (≤25 chars with history) skip tool subsetting** — the
  conversation decides what "ya do it" means, so the LLM gets the full menu.
- **Full-set retry:** if a category subset produced NO tool call, retry once
  with all tools. This directly targets GAP-REPORT failure mode #1. Kill
  switch: `INTENT_FULLSET_RETRY=false`. (Cost note: casual chatter that
  happens to keyword-match a category — roughly a third of casual messages —
  pays a second intent call. Disable the flag if that cost matters more than
  the recovered accuracy.)
- **Assistant history turns keep 1500 chars** (was 500) so numbered lists
  survive for "the 7th one" (`AI_INTENT_CONTEXT_TRUNCATE_ASSISTANT`).
- Semantic router: `visa` category and its few-shot examples removed; context-
  dependent replies ("send all", "the first one") now classify as chat →
  full tool set.
- `classifyConfirmation`: decision validated against the allowed enum —
  a garbled LLM reply can no longer default to **confirm**.

### Tools (`src/services/tool-definitions.js`, `tool-schemas.js`)
- **New `request_clarification` tool** (always present in every subset via
  `ESSENTIAL_TOOLS`): the model can ask ONE short question with 2–3 options
  instead of guessing a side-effectful action. Handled by the `clarify` case
  in `executeIntent`.
- **Core-priority padding** (`CORE_PAD_TOOLS`): subset padding now prefers the
  17 high-traffic tools instead of file order, so a wrong category guess still
  leaves reminders/calendar/email/tasks/notes on the menu. Subset limit is
  `TOOL_SUBSET_LIMIT` (default 24).
- `news_deep_dive` no longer claims every bare-number reply.
- All Zod enums synced to tool definitions (62 keys verified; 223 enum values
  parse); dead/mis-keyed schemas renamed or removed.

### Conversation flow (`webhook.controller.js`, `confirmation-gate.service.js`)
- **Tool-path exchanges are now saved to conversation history** (both WhatsApp
  and platform handlers, fire-and-forget). This is what makes follow-ups and
  clarification answers resolvable.
- **Confirmation gate** is negation- and refusal-aware: `"ok, don't send it
  yet"`, `"pls cancel"`, `"ok cancel that"` cancel; `"yess"/"han bhej de"/
  "krdo"` confirm; genuinely ambiguous replies go to the LLM classifier —
  whose *cancel/edit/new-topic* verdicts apply, but whose **confirm verdict
  never executes** (hard-gate invariant: only the strict allowlist can fire an
  outbound send; anything else nags for an explicit "yes"). New-topic replies
  fall through to normal routing instead of being swallowed; after 2 of them
  the stale pending action expires.
- Bare `"stop"` only stops a meeting if one is actually active; otherwise it
  falls through to the pending flow ("stop" as flow-cancel now works).
- Briefing one-word CTAs (`skip/more/plan/status`) require a briefing sent in
  the last 3h (`BRIEFING_REPLY_WINDOW_MS`) and no other active flow; the
  detailed-preference briefing path now records that context too.
- Delegated-task `"done"/"nope"` intercept yields when any flow is actively
  waiting for the user's reply (`_hasActiveConversationFlow`; long-TTL poll /
  standup contexts only count as "active" for 30 minutes).
- Per-user lock: `message` hoisted + `userLockAcquired` flag — the lock is
  released exactly by the request that acquired it (was: never released, 15s
  stall per rapid follow-up).
- Cache warmer delegates to the real prompt builders and the real subset limit
  so warmed prefixes actually match runtime calls.

## New / relevant env flags

| Flag | Default | Meaning |
|---|---|---|
| `INTENT_PROMPT_VERSION` | `v3` | `v1`/`v2` roll back to old prompts |
| `INTENT_FULLSET_RETRY` | `true` | retry with all tools when a subset returns no tool |
| `INTENT_SHORT_FOLLOWUP_LEN` | `25` | max length for the subsetting bypass |
| `TOOL_SUBSET_LIMIT` | `24` | tools per category subset |
| `AI_INTENT_CONTEXT_TRUNCATE_ASSISTANT` | `1500` | per-assistant-turn history chars for intent |
| `BRIEFING_REPLY_WINDOW_MS` | `10800000` | window for one-word briefing CTAs |

## How to test

**Offline unit/regression (no keys, runs in CI):**
```
npm test                                   # includes tests/intent-routing.test.js (25 cases)
```
Covers: subsetting safety nets, short-message gating, full-set retry,
v3-prompt selection, confirmation-gate matrix (incl. "pls cancel" and
"ok, don't send it yet"), hard-gate invariant, deflection expiry,
classifyConfirmation fallbacks.

**Live intent accuracy (needs provider keys from .env):**
```
node scripts/test-intent-golden-set.js     # 35 cases incl. new K1-K10 casual/typo/Hinglish set
```
Compare v3 vs old prompt directly:
```
INTENT_PROMPT_VERSION=v1 node scripts/test-intent-golden-set.js
INTENT_PROMPT_VERSION=v3 node scripts/test-intent-golden-set.js
```

**Live feature suites (promptfoo):**
```
DISABLE_CIRCUIT_BREAKERS=1 npx promptfoo eval -c test/feature-1-reminders.100.yaml --no-cache -j 4 --output test/results/after.json
node test/analyze-results.js test/results/after.json
```

**Manual WhatsApp scenarios worth re-checking (each was a concrete failure):**
1. "help me write an email to my boss abt the delay" → drafts an email (was: help menu).
2. "show my reminders" → reply "2" → acts on reminder 2 (was: small talk).
3. "kal 5 baje rahul" → asks *meeting or reminder?* (was: guessed).
4. Email confirm pending → "ok, don't send it yet" → does NOT send.
5. Email confirm pending → "whats the weather in delhi" → answers the weather
   (was: nag loop); the pending draft survives one topic change.
6. "remind me at 5" then "pm i mean" 3s later → no 15s stall.
7. Bot asks a clarifying question → "stop" → cancels the flow (was: "No active
   meeting found to stop").
8. Send a team poll in the morning; in the evening reply "done" for a
   delegated task → task completes (was: recorded as poll interaction).
