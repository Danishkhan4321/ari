/* ─── Feature data with use cases for individual pages ─── */

export interface UseCase {
  title: string;
  desc: string;
  example: string;
  emoji: string;
}

export interface FeatureChat {
  user: string;
  ari: string;
}

export interface Feature {
  slug: string;
  title: string;
  category: string;
  color: string;
  tagline: string;
  overview: string;
  desc: string;
  whoFor: string[];
  useCases: UseCase[];
  chat: FeatureChat;
  benefits: string[];
}

export const features: Feature[] = [
  /* ─── Memory & Reminders ─── */
  {
    slug: "unlimited-reminders",
    title: "Unlimited Reminders",
    category: "Memory & Reminders",
    color: "bg-card-teal",
    tagline: "Never forget anything, ever again.",
    overview: "Set reminders by just talking. One-time, recurring, or location-based — Ari handles them all.",
    desc: "Set one-time or recurring reminders in natural language. Ari handles time zones, repeats, and nudges.",
    whoFor: ["Busy professionals", "Parents", "Students", "Anyone who forgets things"],
    useCases: [
      { emoji: "💊", title: "Medication", desc: "Daily pill reminders that never miss.", example: '"Remind me to take my BP medicine every day at 8 AM"' },
      { emoji: "🎂", title: "Birthdays & Anniversaries", desc: "Never forget the important dates.", example: '"Remind me 2 days before mom\'s birthday on March 15"' },
      { emoji: "📞", title: "Follow-ups", desc: "Auto-remind to call back clients or friends.", example: '"Remind me to call Rahul next Monday at 11 AM"' },
      { emoji: "📍", title: "Location-based", desc: "Get reminded when you reach a place.", example: '"Remind me to buy milk when I reach home"' },
    ],
    chat: {
      user: "Remind me to submit the tax docs every Friday at 5 PM",
      ari: "Done! ✅ I'll ping you every Friday at 5 PM to submit your tax docs. Reply 'snooze' anytime to delay.",
    },
    benefits: ["Zero missed appointments", "Recurring reminders without setup", "Works across timezones", "Snooze, reschedule, or cancel anytime"],
  },
  {
    slug: "smart-memory",
    title: "Smart Memory",
    category: "Memory & Reminders",
    color: "bg-card-teal",
    tagline: "Your second brain that never forgets.",
    overview: "Tell Ari anything once. It remembers forever and brings it back exactly when you need it.",
    desc: "Tell Ari anything — passport numbers, family birthdays, WiFi passwords. It remembers forever.",
    whoFor: ["Forgetful people", "Travelers", "Busy parents", "Knowledge workers"],
    useCases: [
      { emoji: "🔐", title: "Important Numbers", desc: "Passport, Aadhaar, license — recall in seconds.", example: '"My passport is X12345, expires Dec 2028"' },
      { emoji: "📡", title: "Passwords & WiFi", desc: "Stop digging through notes apps.", example: '"WiFi password for office is starlink2024"' },
      { emoji: "👨‍👩‍👧", title: "Family Info", desc: "Birthdays, anniversaries, blood types.", example: '"Dad\'s blood group is O+, allergic to penicillin"' },
      { emoji: "🚗", title: "Personal Records", desc: "Car insurance, gym membership IDs.", example: '"Car insurance expires March 12, policy #INS-9923"' },
    ],
    chat: {
      user: "What's my passport number?",
      ari: "Your passport is X12345, expiring Dec 2028. Want me to remind you 6 months before renewal?",
    },
    benefits: ["Recall in seconds", "Encrypted & private", "Search by keyword", "Never lose important info"],
  },
  {
    slug: "notes-and-bookmarks",
    title: "Notes & Bookmarks",
    category: "Memory & Reminders",
    color: "bg-card-teal",
    tagline: "Capture ideas before they slip away.",
    overview: "Save thoughts, links, articles mid-conversation. Just type 'save this' and it's organized forever.",
    desc: "Save ideas, links, thoughts, and snippets mid-conversation. Searchable and organized.",
    whoFor: ["Researchers", "Content creators", "Students", "Idea collectors"],
    useCases: [
      { emoji: "💡", title: "Quick Ideas", desc: "Brain dump random thoughts on the go.", example: '"Save: build a Chrome extension for note-taking"' },
      { emoji: "🔗", title: "Links to Read Later", desc: "Bookmark articles without switching apps.", example: '"Save this article: [link]"' },
      { emoji: "📚", title: "Research", desc: "Collect quotes, snippets, references.", example: '"Note: Stripe pricing is 2.9% + $0.30 per transaction"' },
      { emoji: "🔍", title: "Search Everything", desc: "Find any saved note in seconds.", example: '"Find my notes about React performance"' },
    ],
    chat: {
      user: "Save: idea — voice-to-task feature for Ari using Whisper",
      ari: "Saved! 📝 Tagged under #ideas #ari. Reply 'show ideas' anytime to review them all.",
    },
    benefits: ["Capture in seconds", "Auto-tagged", "Full-text search", "Never lose an idea"],
  },
  {
    slug: "daily-briefing",
    title: "Daily Briefing",
    category: "Memory & Reminders",
    color: "bg-card-teal",
    tagline: "Your day, summarized in one message.",
    overview: "Wake up to a single morning message: meetings, tasks, reminders, and priorities. No app to open.",
    desc: "Every morning: today's meetings, pending tasks, active reminders — all in one message.",
    whoFor: ["Busy professionals", "Founders", "Managers", "Anyone with a packed schedule"],
    useCases: [
      { emoji: "☀️", title: "Morning Overview", desc: "Know your day before opening your laptop.", example: 'Auto-sent at 7 AM: "3 meetings, 5 tasks, 2 urgent emails"' },
      { emoji: "📅", title: "Meeting Prep", desc: "See who you're meeting and why.", example: '"10 AM: Pitch with Sequoia. 2 PM: Standup. 4 PM: Demo for Acme."' },
      { emoji: "✅", title: "Priority Tasks", desc: "Top 3 things to tackle first.", example: '"Top 3: Finish proposal, Review PR, Call client"' },
      { emoji: "🔔", title: "Quick Wins", desc: "What you can knock out before lunch.", example: '"Quick wins: 4 emails to reply, 2 tasks under 15 min"' },
    ],
    chat: {
      user: "What's my day like?",
      ari: "🌅 Good morning! Today: 3 meetings (10 AM, 2 PM, 4 PM), 5 pending tasks, 2 urgent emails. Top priority: finish the Acme proposal.",
    },
    benefits: ["No app to open", "Sets your day's intention", "Customizable timing", "Includes weather + news"],
  },
  {
    slug: "daily-news",
    title: "Daily News Digest",
    category: "Memory & Reminders",
    color: "bg-card-orange",
    tagline: "Stay informed without doomscrolling.",
    overview: "Get the headlines that matter every morning — tech, business, world, sports, or your custom topics.",
    desc: "Curated news every morning — tech, business, world, sports, or your custom topics. No doomscrolling.",
    whoFor: ["News junkies", "Busy professionals", "Industry watchers", "Investors"],
    useCases: [
      { emoji: "🌍", title: "World News", desc: "Top global headlines, summarized.", example: 'Auto-sent at 7 AM: "5 top stories from world, tech, business"' },
      { emoji: "💼", title: "Industry Updates", desc: "Track your specific industry.", example: '"Track AI startup news daily" → curated each morning'},
      { emoji: "📈", title: "Market Watch", desc: "Stocks, crypto, IPOs at a glance.", example: '"Send market summary at 9:30 AM" → daily digest'},
      { emoji: "⚽", title: "Sports & Hobbies", desc: "Your teams, your races, your hobbies.", example: '"Track F1 news and Manchester United updates"'},
    ],
    chat: {
      user: "Add Indian startup funding news to my digest",
      ari: "📰 Added! From tomorrow you'll get Indian startup funding headlines along with your daily digest at 7 AM.",
    },
    benefits: ["No doomscrolling", "Multiple categories", "Custom topics", "Choose your time"],
  },
  /* ─── Calendar & Scheduling ─── */
  {
    slug: "unified-calendar",
    title: "Unified Calendar",
    category: "Calendar & Scheduling",
    color: "bg-card-lemon",
    tagline: "All your calendars. One view.",
    overview: "Google, Outlook, Apple — combined into one searchable, askable calendar on WhatsApp.",
    desc: "Google + Outlook + Apple Calendar synced into one view. Ask in natural language.",
    whoFor: ["People with multiple calendars", "Consultants", "Freelancers", "Founders"],
    useCases: [
      { emoji: "📆", title: "Week at a Glance", desc: "See all calendars in one ask.", example: '"What does my week look like?"' },
      { emoji: "🔍", title: "Find Free Time", desc: "Get available slots in seconds.", example: '"Find me 1 hour free this week"' },
      { emoji: "📞", title: "Meeting Lookup", desc: "Find any meeting by topic or person.", example: '"When am I meeting Priya next?"' },
      { emoji: "🌍", title: "Time Zones", desc: "No more conversion math.", example: '"Schedule call with NYC client tomorrow at their 10 AM"' },
    ],
    chat: {
      user: "What does my Friday look like?",
      ari: "📅 Friday: 3 meetings (Standup 10 AM, Pitch 2 PM, Demo 4 PM), 1 lunch (12:30 PM with Raj). You're free 11 AM–12:30 PM.",
    },
    benefits: ["No app switching", "All calendars synced", "Natural search", "Time zone smart"],
  },
  {
    slug: "natural-event-creation",
    title: "Natural Event Creation",
    category: "Calendar & Scheduling",
    color: "bg-card-lemon",
    tagline: "Schedule meetings like you talk.",
    overview: "Type a sentence. Ari creates the event, sends invites, sets reminders. Zero forms.",
    desc: "\"Schedule a call with Priya on Friday at 3 PM\" — Ari creates the event, sends invite, sets reminder.",
    whoFor: ["People who hate filling forms", "Mobile-first users", "Anyone scheduling many meetings"],
    useCases: [
      { emoji: "🗓️", title: "Quick Meetings", desc: "Schedule in 5 seconds, not 5 minutes.", example: '"Meet John at 3 PM tomorrow"' },
      { emoji: "🔁", title: "Recurring Events", desc: "Set weekly standups in one message.", example: '"Schedule team standup every weekday at 10 AM"' },
      { emoji: "👥", title: "Group Invites", desc: "Send invites to multiple people at once.", example: '"Schedule sprint planning with Raj, Priya, and Anil on Monday 11 AM"' },
      { emoji: "📍", title: "With Location", desc: "Add Zoom link or address inline.", example: '"Coffee meeting at Starbucks Indiranagar, Friday 4 PM"' },
    ],
    chat: {
      user: "Schedule a call with Priya on Friday at 3 PM about Q2 review",
      ari: "✅ Created: 'Q2 Review Call with Priya' — Friday, 3:00–3:30 PM. Invite sent to priya@email.com. Reminder set for 2:45 PM.",
    },
    benefits: ["No forms or dropdowns", "Auto-invites attendees", "Auto-sets reminders", "Detects conflicts"],
  },
  {
    slug: "conflict-detection",
    title: "Conflict Detection",
    category: "Calendar & Scheduling",
    color: "bg-card-lemon",
    tagline: "Never double-book yourself.",
    overview: "Before booking anything, Ari checks your full calendar across all accounts. Suggests alternatives if there's a clash.",
    desc: "Ari checks for overlaps before booking. Suggests alternatives smart.",
    whoFor: ["Heavy meeting people", "Sales teams", "Recruiters", "Consultants"],
    useCases: [
      { emoji: "⚠️", title: "Auto-warning", desc: "Get alerted before clashes happen.", example: '"You already have a 3 PM. Book at 4 instead?"' },
      { emoji: "🔄", title: "Smart Suggestions", desc: "AI suggests next-best times.", example: '"Try Wednesday 11 AM, Friday 2 PM, or Monday 10 AM"' },
      { emoji: "🚦", title: "Buffer Time", desc: "Adds 15-min gaps between meetings.", example: '"Auto-add 15 min buffer after each meeting"' },
      { emoji: "⚡", title: "Quick Reschedule", desc: "Move meetings without back-and-forth.", example: '"Move my 4 PM to tomorrow same time"' },
    ],
    chat: {
      user: "Schedule a call at 3 PM Friday",
      ari: "⚠️ You already have 'Pitch with Sequoia' at 3 PM Friday. Try Friday 4 PM, or Monday 11 AM?",
    },
    benefits: ["Zero double-bookings", "Smart alternatives", "Auto-buffer", "Quick reschedule"],
  },
  /* ─── Email ─── */
  {
    slug: "email-command-center",
    title: "Email Command Center",
    category: "Email & Communication",
    color: "bg-card-pink",
    tagline: "Your inbox, controlled from WhatsApp.",
    overview: "Send, read, search, schedule — all your email work without ever opening Gmail or Outlook.",
    desc: "Send, search, schedule, organize emails without opening your inbox.",
    whoFor: ["Email-heavy professionals", "Founders", "Sales teams", "Mobile-first workers"],
    useCases: [
      { emoji: "✉️", title: "Quick Send", desc: "Draft and send emails in chat.", example: '"Email Raj: meeting moved to 4 PM"' },
      { emoji: "📥", title: "Smart Inbox", desc: "Get summaries of new emails.", example: '"Any important emails today?"' },
      { emoji: "🔍", title: "Search Inbox", desc: "Find any old email instantly.", example: '"Find email from Stripe about pricing"' },
      { emoji: "📤", title: "Send Drafts", desc: "Ari drafts, you approve.", example: '"Draft a follow-up to the Acme proposal"' },
    ],
    chat: {
      user: "Email the team about tomorrow's offsite",
      ari: "📝 Drafted: 'Subject: Tomorrow's Offsite Reminder. Body: Hey team, quick reminder...' — Approve to send?",
    },
    benefits: ["No app switching", "Drafts in seconds", "Smart inbox triage", "Schedule sends"],
  },
  {
    slug: "scheduled-emails",
    title: "Scheduled Emails",
    category: "Email & Communication",
    color: "bg-card-pink",
    tagline: "Send emails at the perfect time.",
    overview: "Write now, send later. Schedule emails for early mornings, business hours, or specific moments.",
    desc: "Write now, send later. Schedule emails for the perfect timing.",
    whoFor: ["Sales teams", "Marketers", "Remote workers across timezones", "Founders"],
    useCases: [
      { emoji: "🌅", title: "Morning Send", desc: "Hit inboxes when they're checked.", example: '"Send this proposal Monday at 9 AM"' },
      { emoji: "🌍", title: "Time Zone Send", desc: "Reach clients in their timezone.", example: '"Email US client at their 10 AM"' },
      { emoji: "🎯", title: "Follow-up Cadence", desc: "Auto-send follow-ups in sequence.", example: '"Send follow-up in 3 days if no reply"' },
      { emoji: "📅", title: "Future Events", desc: "Pre-write announcements.", example: '"Send launch email on March 15 at 8 AM"' },
    ],
    chat: {
      user: "Send this proposal to client@acme.com Monday 9 AM",
      ari: "📅 Scheduled! Will send your proposal to client@acme.com on Monday at 9:00 AM. Reply 'cancel' to stop it.",
    },
    benefits: ["Perfect timing", "Time zone aware", "Cancel anytime", "No browser tabs needed"],
  },
  /* ─── Tasks ─── */
  {
    slug: "task-board",
    title: "Task Board",
    category: "Tasks & Project Management",
    color: "bg-card",
    tagline: "Kanban without the dashboard.",
    overview: "Add, assign, and track tasks through chat. No Trello, no Asana, no Notion — just messages.",
    desc: "Create, assign, and track tasks with a Kanban board — managed entirely through chat.",
    whoFor: ["Small teams", "Founders", "Project managers", "Freelancers"],
    useCases: [
      { emoji: "✅", title: "Quick Add", desc: "Add tasks in 5 seconds.", example: '"Add task: review Q2 budget by Friday"' },
      { emoji: "👥", title: "Assign to Team", desc: "Delegate without switching apps.", example: '"Assign \'design landing page\' to Raj by Monday"' },
      { emoji: "📊", title: "Status Updates", desc: "Move tasks through stages.", example: '"Mark \'API integration\' as done"' },
      { emoji: "🎯", title: "Priorities", desc: "Set urgency on the fly.", example: '"Mark \'fix login bug\' as urgent"' },
    ],
    chat: {
      user: "Add task: prepare investor deck, due Thursday, assign to me",
      ari: "✅ Added: 'Prepare investor deck' — assigned to you, due Thursday. Now in your To-Do board (3 tasks total).",
    },
    benefits: ["No new app to learn", "Team can use too", "Auto-reminders on due dates", "Visual board on demand"],
  },
  /* ─── Meetings ─── */
  {
    slug: "meeting-recorder",
    title: "AI Meeting Recorder",
    category: "Meetings & Transcription",
    color: "bg-card-purple text-white",
    tagline: "Capture the call when you choose.",
    overview: "Click Record Meeting in Ari Desktop to capture system and microphone audio, retain the recording privately, and generate a speaker-labeled transcript and complete report.",
    desc: "Manual desktop recording with AssemblyAI transcription, speaker rename, summaries, decisions, action items, and task suggestions.",
    whoFor: ["Sales teams", "Founders", "Consultants", "Anyone tired of taking notes during calls"],
    useCases: [
      { emoji: "🎙️", title: "You Control Capture", desc: "Start, pause, resume, and stop from the Meetings page.", example: "Record system and microphone audio together" },
      { emoji: "📝", title: "Speaker-Labeled Transcript", desc: "Rename Speaker A or Speaker B once and update every output.", example: "Speaker A → Raj" },
      { emoji: "✅", title: "Structured Outcomes", desc: "Extract decisions, action items, and suggested owners without silently creating tasks.", example: "Review task suggestions before confirming" },
      { emoji: "🔍", title: "Complete Report", desc: "Keep the retained recording, transcript, summary, and detailed report together.", example: "Replay the recording from the meeting detail page" },
    ],
    chat: {
      user: "Record this meeting",
      ari: "Open Meetings in Ari Desktop and click Record Meeting. When you stop, I’ll transcribe it and prepare the full report.",
    },
    benefits: ["System + microphone audio", "AssemblyAI transcription", "Renameable speakers", "Private retained recordings"],
  },
  {
    slug: "meeting-summary",
    title: "Meeting Summary",
    category: "Meetings & Transcription",
    color: "bg-card-purple text-white",
    tagline: "AI-generated recaps in seconds.",
    overview: "Every meeting ends with a structured summary: decisions, action items, deadlines, owners. All sent to WhatsApp.",
    desc: "AI-generated recap: key decisions, action items, deadlines. Sent the moment meeting ends.",
    whoFor: ["Project managers", "Sales teams", "Executives", "Distributed teams"],
    useCases: [
      { emoji: "🧠", title: "Key Decisions", desc: "What got decided, by whom.", example: '"Decision: Launch on March 15. Owner: Marketing team."' },
      { emoji: "📌", title: "Action Items", desc: "Who needs to do what, by when.", example: '"Raj: finish API by Friday. Priya: design review by Wed."' },
      { emoji: "📨", title: "Auto-share", desc: "Send to attendees automatically.", example: '"Share summary with all attendees"' },
      { emoji: "💼", title: "MoM Generation", desc: "Formal Minutes of Meeting on demand.", example: '"Generate MoM for the board meeting"' },
    ],
    chat: {
      user: "Summarize my last meeting",
      ari: "📋 Q2 Planning (45 min):\n✅ Decisions: Hire 2 engineers, delay launch by 2 weeks\n📌 Action items: Raj-API by Fri, Priya-Design by Wed\n👥 5 attendees",
    },
    benefits: ["Sent within minutes", "Action items per person", "Searchable later", "Optional MoM format"],
  },
  /* ─── Voice & Standups ─── */
  {
    slug: "voice-messages",
    title: "Voice Messages",
    category: "Personal Productivity",
    color: "bg-card-lemon",
    tagline: "Too busy to type? Just speak.",
    overview: "Send Ari a voice message and it handles everything — reminders, emails, tasks, meetings. No typing needed.",
    desc: "Send a voice note. Ari understands 100+ languages and handles your request.",
    whoFor: ["Drivers", "Walkers", "Multitaskers", "Anyone tired of typing"],
    useCases: [
      { emoji: "🚗", title: "Driving", desc: "Voice command without taking hands off wheel.", example: '🎤 "Remind me to call mom when I get home"' },
      { emoji: "🚶", title: "Walking", desc: "Capture thoughts on the move.", example: '🎤 "Save: idea for marketing campaign next week"' },
      { emoji: "🌍", title: "Any Language", desc: "Speak in Hindi, Spanish, Arabic — anything.", example: '🎤 "Mom ko bolo dinner pe aana hai" (Hindi)' },
      { emoji: "⚡", title: "Faster Than Typing", desc: "3x faster for long instructions.", example: '🎤 30-sec voice = 3 min typing'},
    ],
    chat: {
      user: "🎤 (voice 0:08): \"Remind me to call mom at 6 PM and schedule meeting with Rahul tomorrow at 10 AM\"",
      ari: "✅ Done!\n• Reminder: Call mom at 6:00 PM today\n• Meeting: Rahul tomorrow at 10:00 AM (calendar invite sent)",
    },
    benefits: ["100+ languages", "Hands-free productivity", "Faster than typing", "Multi-task command in one voice note"],
  },
  {
    slug: "automated-standups",
    title: "Automated Standups",
    category: "Team & Collaboration",
    color: "bg-card-lime",
    tagline: "Kill the daily standup meeting.",
    overview: "Ari DMs each team member at standup time, collects their updates, and posts a clean report. Saves 15 minutes per person, every day.",
    desc: "Ari asks each member for updates, compiles into one clean report. No more 15-min status meetings.",
    whoFor: ["Engineering teams", "Remote teams", "Startup founders", "Any team doing daily standups"],
    useCases: [
      { emoji: "⏰", title: "Auto-Trigger", desc: "Sends standup questions at fixed time.", example: 'Auto at 10 AM: "What did you do? What\'s today? Blockers?"' },
      { emoji: "📊", title: "Compiled Report", desc: "All answers in one clean message.", example: 'At 10:30 AM: "Standup report — 5 of 6 replied"'},
      { emoji: "🚨", title: "Block Alerts", desc: "Highlight blocked team members.", example: '"⚠️ Raj is blocked on API review. Help needed."' },
      { emoji: "📈", title: "Weekly Trends", desc: "See team velocity over time.", example: '"Show standup trends this week"' },
    ],
    chat: {
      user: "Set up daily standup at 10 AM for my team",
      ari: "✅ Done! Every weekday at 10 AM, I'll DM your team. Report posted to your group at 10:30 AM with everyone's updates.",
    },
    benefits: ["Saves 15 min/day per person", "Async-friendly", "Clean reports", "Spot blockers early"],
  },
  /* ─── Sales ─── */
  {
    slug: "sales-pipeline",
    title: "Sales Pipeline",
    category: "Sales & CRM",
    color: "bg-card-orange",
    tagline: "CRM in your pocket. No login required.",
    overview: "Track leads, deals, and pipeline stages — all from WhatsApp. Add a lead in 5 seconds, get pipeline insights in one ask.",
    desc: "Track leads from first touch to closed deal. Manage entire pipeline through chat.",
    whoFor: ["Sales reps", "Founders selling", "Solo consultants", "Small sales teams"],
    useCases: [
      { emoji: "➕", title: "Add Leads Fast", desc: "Capture leads in seconds.", example: '"Add lead: Acme Corp, $50K, met at TechCrunch"' },
      { emoji: "📊", title: "Pipeline View", desc: "Get a snapshot anytime.", example: '"Show pipeline" → 12 leads, $300K total, 4 close-ready' },
      { emoji: "🔔", title: "Stage Updates", desc: "Move deals through funnel.", example: '"Move Acme to negotiation stage"' },
      { emoji: "📞", title: "Follow-up Reminders", desc: "Never let leads go cold.", example: '"Remind me to follow up with Acme in 3 days"' },
    ],
    chat: {
      user: "How's the pipeline this month?",
      ari: "📊 Pipeline Snapshot:\n💰 Total: $320K (12 leads)\n🔥 Hot: 4 deals worth $180K\n⏰ Stale (>14 days): 2 leads to revive",
    },
    benefits: ["No CRM login", "5-second lead entry", "Auto-follow-ups", "Real-time analytics"],
  },
];

export const featureBySlug = (slug: string): Feature | undefined =>
  features.find((f) => f.slug === slug);

export const allSlugs = features.map((f) => f.slug);
