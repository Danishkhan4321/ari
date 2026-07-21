# PRD — Ari

> Product Requirements Document. What we're building, who it's for, and why.

## 1. The one-liner

A WhatsApp-first AI assistant that lets small-team founders manage their team and run sales outreach from one chat — without juggling Slack, a CRM, email, and Notion.

## 2. Target user

**Primary:** Founders running 5–20 person teams in India (and globally), especially in B2B SaaS, agencies, real estate, and SMB services. People who:
- Already live in WhatsApp all day (it's the default in India)
- Don't want to context-switch between 4 tools
- Run their team chat there anyway

**Why founders, not enterprise:** founders make the decision, pay personally, and adopt fast. Enterprise sales is a different motion.

**Secondary:** Their team members (designers, ops, sales reps). Free tier; participate in standups, vote in polls, get task assignments — without needing their own subscription.

## 3. The problem we solve

Today a founder running a 10-person team uses something like:
- **Slack** for team chat (+ their personal Slack DMs)
- **HubSpot/Pipedrive/Notion** for CRM
- **Gmail** for outreach + scheduling
- **Notion / Linear** for tasks
- A separate recorder and transcription tool for meetings
- **Calendly** for scheduling
- **WhatsApp** anyway, because clients/team prefer it

That's 7 tools, ~$200/mo subscriptions, lots of tab-switching, nothing connected. Ari collapses the whole stack into one WhatsApp chat — with a web dashboard for when a screen is more comfortable.

## 4. Core features (live)

### Personal productivity (Free tier)
- ⏰ **Reminders** — natural-language ("kal subah 9 baje yaad dilana gym jaana hai"). Handles English, Hindi, Hinglish, and ~20 other languages.
- 💾 **Memory** — "remember my anniversary is Dec 15" → it remembers, surfaces it the right moment.
- 🔍 **Web search** — 12/month free, unlimited on paid.
- 🌐 **Language** — auto-detect, replies in the user's language.

### Productivity Plus (Cub plan, ₹—/mo)
- 📊 **Daily briefing** — every morning at user's local hour: tasks due, calendar, top news, inbox highlights.
- 👥 **Contact management** — save, recall, mask sensitive numbers.
- 🌍 **Timezone management** — sets per user, all reminders/briefings respect it.
- 🎙️ **Voice notes** — transcribed via Sarvam with Whisper fallback.
- 🔗 **Account link** — connect Google + Microsoft accounts for the next tier.

### Team & Outreach (Pack plan)
- 📅 **Google + Microsoft Calendar** — create, view, reschedule, send invites
- ✉️ **Gmail/Outlook** — send, reply-track, schedule, bulk send, follow-up
- ✅ **Tasks** — assign to self or others, hourly nudges, flexible follow-up cadence
- 🏃 **Sprints** — stories, points, velocity, daily updates, end-of-sprint recap
- 🌅 **Standups** — daily/weekly, multi-question, AI alignment analysis
- 🗳️ **Polls + leaves + shared boards + sales pipeline + incidents + time tracking**

### Meeting assistant (Alpha plan)
- 🎙️ **Record Meeting** captures system and microphone audio from the desktop app
- 📝 **AssemblyAI transcription** with Speaker A/B labels that users can rename
- ✅ **Summary, decisions, action items, suggested tasks/assignees, and full report**
- 📹 **Retained private recordings** with authenticated playback

## 5. The dashboard

A hosted workspace with a desktop companion for native workflows. It provides the same team data in a screen-friendly interface, with secure authentication and integrations.

Sections live:
- **Chat** — full conversation with the bot
- **CRM** — sales pipeline kanban, contacts, leads
- **Reminders** — list, filter, snooze
- **Tasks** — assigned, mine, delegated
- **Inbox** — scheduled emails
- **Meetings** — recordings, transcripts
- **Team** — members, standups, polls, leave
- **Notes & KB** — knowledge base, reading list
- **Productivity** — habits, focus, expenses
- **Settings** — plan, integrations, timezone

## 6. Plans

| Plan | Who | Price | What unlocks |
|---|---|---|---|
| **Free** | New users | ₹0 | 5 reminders/month, 12 searches/month, 30 AI chats/month, 10 voice notes/month |
| **Cub** | Solo power user | ~₹—/mo | Unlimited reminders, briefings, voice, contacts, dashboard |
| **Pack** | Small team founder | ~₹—/mo | Email, calendar, tasks, sprints, standups, CRM, team workflows |
| **Alpha** | Heavy user | ~₹—/mo | Manual recording, transcripts, reports |

**Team-member exemption:** Free users who are added as team members of a paid admin can reply to standups, vote in polls, apply for leave, see team availability — without their own subscription. The admin's plan covers participation; only creation/admin actions require the member to be on Pack+.

## 7. Key user journeys

1. **Reminder reply** — User: "remind me tomorrow 9am to call mom" → Bot: "Got it — tomorrow at 9am, call mom" → next day at 9am: notification.
2. **Lead capture** — User: "new lead John from Acme, john@acme.com, interested in premium" → bot adds to `sales_leads`, surfaces in CRM dashboard, queues a follow-up reminder.
3. **Record meeting** — User opens Meetings → clicks Record Meeting → grants system-audio and microphone access → stops recording → receives transcript, summary, decisions, action items, suggested tasks/assignees, and a full report.
4. **Team standup** — Admin sets up daily standup → 9am every day, bot DMs each team member 3 questions → members reply → bot aggregates → posts the digest to the admin.
5. **Dashboard chat** — User in browser types in `/chat` → goes through internal API to bot → bot processes via the same pipeline as WhatsApp → reply lands in the dashboard chat panel.

## 8. Differentiators

- **WhatsApp-first** (most competitors are web-only)
- **Hinglish-native** (Indian founders' real-world language)
- **Voice notes accepted** (the dominant input mode for many users)
- **One assistant for the whole stack** (vs point tools)
- **Multi-vendor LLM with circuit breakers** (resilient when Gemini/OpenAI flap)
- **Unified CRM data, no third-party lock-in**

## 9. Non-goals (intentionally NOT building)

- Enterprise SSO / SAML
- Self-hosted on-prem
- Generic chatbot for end consumers (we're for founders)
- Marketing automation / drip campaigns at scale
- Full ERP / accounting
- White-labeling

## 10. Success metrics

- **Activation:** % of new sign-ups who complete the first reminder within 24h
- **Retention:** Daily active / monthly active among paid users
- **Plan upgrade:** Free → Cub conversion rate; Cub → Pack
- **Meeting recorder:** Completed recordings per Alpha user per month
- **NPS:** From paid users via WhatsApp poll once a quarter

## 11. Open questions / known risks

- WhatsApp Cloud API rate limits at higher volume
- Cost of LLM calls at scale (mitigated by Gemini Flash + caching)
- AssemblyAI and retained-recording storage cost at scale
- Razorpay UX for INR billing internationally
- LinkedIn / email enrichment legal/ToS risk (under investigation, currently external API like Tomba)

## 12. Roadmap (next 90 days, indicative)

- **Email enrichment** — "find John's email at Acme" → Tomba API → save to CRM
- **Organization seats** — one Alpha plan covers a whole team's seats
- **Notification prefs** — per-user quiet hours, mute categories
- **Re-upgrade flow** — graceful pause/resume on plan downgrade
- **Inbound email → task** automation
- **Meeting consent guidance** — make local recording obligations clear before capture
- **Audit log read API** in dashboard for ops

See STATUS.md for the full implemented/pending breakdown.
