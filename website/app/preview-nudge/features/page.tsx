"use client";

import {
  PageShell,
  Reveal,
  Sticker,
  HandLabel,
  BlackPill,
  OutlinePill,
} from "../_shared";
import { motion } from "framer-motion";
import Link from "next/link";
import { features as featuresData } from "@/lib/features-data";

const slugByTitle = new Map(featuresData.map((f) => [f.title, f.slug]));

const categories = [
  {
    name: "Memory & Reminders",
    bg: "#7BD3F7",
    emoji: "🧠",
    features: [
      { title: "Unlimited Reminders", desc: "Set one-time or recurring reminders in natural language. \"Remind me every Monday at 9 AM.\" Ari handles time zones, repeats, and nudges." },
      { title: "Smart Memory", desc: "Tell Ari anything — your passport number, mom's birthday — and it remembers forever. Recall instantly when you ask." },
      { title: "Notes & Bookmarks", desc: "Save ideas, links, and snippets mid-conversation. Just type \"save this\" — stored, searchable, organized." },
      { title: "Daily Briefing", desc: "Every morning, one message: today's meetings, pending tasks, active reminders. Your command center in a glance." },
      { title: "Daily News Digest", desc: "Wake up to headlines that matter — tech, business, world, your topics. Summarized, delivered to chat." },
    ],
  },
  {
    name: "Calendar & Scheduling",
    bg: "#FFE38C",
    emoji: "📅",
    features: [
      { title: "Unified Calendar", desc: "Google + Outlook + Apple, one view. Ask \"what's my week look like?\" and get a clean cross-account summary." },
      { title: "Natural Event Creation", desc: "\"Schedule a call with Priya Friday 3 PM\" — Ari creates the event, adds the invite, sets a reminder." },
      { title: "Conflict Detection", desc: "Before booking, Ari checks for overlaps and suggests alternatives. Smart scheduling, no back-and-forth." },
      { title: "Calendar Sharing", desc: "Share availability with teammates or external contacts via clean summary. No third-party scheduling tools." },
    ],
  },
  {
    name: "Email & Communication",
    bg: "#FFB1D8",
    emoji: "✉️",
    features: [
      { title: "Email Command Center", desc: "Send, search, schedule, organize without opening your inbox. \"Send a follow-up to the client\" — Ari drafts, you approve." },
      { title: "Scheduled Emails", desc: "Write now, send later. \"Email the team at 9 AM Monday about the sprint review.\" Queued and fired on time." },
      { title: "Inbox Intelligence", desc: "\"Any important emails today?\" — get a prioritized summary. Ari filters the noise so you see what matters." },
      { title: "Email Templates", desc: "Reusable templates for follow-ups, intros, proposals. \"Use the cold outreach template for this lead\" — done." },
    ],
  },
  {
    name: "Tasks & Project Management",
    bg: "#9BE7BF",
    emoji: "✓",
    features: [
      { title: "Task Board", desc: "Create, assign, and track tasks via Kanban — managed entirely through chat. \"Add a task: review Q2 budget, due Friday, assign Raj.\"" },
      { title: "Sprint Planning", desc: "Plan sprints, estimate story points, track velocity — all conversational. \"Start a new sprint with these 5 tasks.\"" },
      { title: "Subtasks & Checklists", desc: "Break big tasks into steps. \"Add subtasks: update landing page, send newsletter, publish blog.\" Track each one." },
      { title: "Progress Reports", desc: "\"Show me sprint progress\" — completion rates, blocked items, overdue tasks. Replace the status meeting." },
    ],
  },
  {
    name: "Team & Collaboration",
    bg: "#DAF464",
    emoji: "👥",
    features: [
      { title: "Automated Standups", desc: "Ari asks each team member at a scheduled time, compiles responses into one report. No more 15-min meetings." },
      { title: "Polls & Voting", desc: "\"Create a poll: lunch — Thursday or Friday?\" Ari sends, collects, announces the winner." },
      { title: "Leave Management", desc: "\"I'm on leave tomorrow\" — logged, team notified, calendar blocked. No HR portal needed." },
      { title: "Team Dashboard", desc: "See who's working on what, who's blocked, who's ahead. Bird's-eye view through one command." },
    ],
  },
  {
    name: "Sales & CRM",
    bg: "#FF9D6E",
    emoji: "📈",
    features: [
      { title: "Sales Pipeline", desc: "Folk-style CRM with drag-drop pipeline (New → Qualified → Demo → Negotiation → Won). Track leads from chat or Ari Desktop." },
      { title: "AI Cold Emails", desc: "\"Draft a cold email for this SaaS lead\" — personalized, compelling email based on lead profile and your product." },
      { title: "Follow-up Automation", desc: "Never let a lead go cold. \"Remind me to follow up Acme in 3 days\" — or let Ari auto-draft the follow-up." },
      { title: "Deal Analytics", desc: "\"How's the pipeline?\" — conversion rates, deal values, stage breakdown in seconds." },
    ],
  },
  {
    name: "Meetings & Transcription",
    bg: "#B7A8FF",
    emoji: "🎥",
    textColor: "white",
    features: [
      { title: "AI Meeting Recorder", desc: "Start capture from Ari Desktop to record system and microphone audio together." },
      { title: "AssemblyAI Transcription", desc: "Speaker labels you can rename across the transcript and every generated output." },
      { title: "Meeting Summary", desc: "Key decisions, action items, deadlines — sent the moment your meeting ends. Ask follow-ups via chat." },
      { title: "Minutes of Meeting", desc: "Formal MoM auto-generated. Action items feed straight into your task board. The meeting generates the work." },
    ],
  },
  {
    name: "Personal Productivity",
    bg: "#FCFDFF",
    emoji: "⚡",
    features: [
      { title: "Focus Mode", desc: "\"Start a 25-minute focus session\" — Ari mutes non-critical reminders, tracks deep work time, gives you a report." },
      { title: "Habit Tracking", desc: "\"Track my meditation streak\" — Ari checks in daily, maintains your streak, celebrates milestones." },
      { title: "Expense Tracking", desc: "\"I spent ₹500 on lunch\" — logged. \"Show this month\" — categorized breakdown instantly." },
      { title: "Contact Management", desc: "Save contacts with context: \"Raj — met at TechCrunch, runs fintech, interested in API.\" Recall anytime." },
    ],
  },
];

export default function FeaturesNudge() {
  return (
    <PageShell>
      {/* HERO */}
      <section className="relative pt-12 pb-32 lg:pb-40 overflow-hidden">
        <Reveal className="text-center">
          <HandLabel text="the arsenal →" width={150} />
        </Reveal>

        <motion.h1
          initial={{ opacity: 0, scale: 0.92, y: 40 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 1, ease: [0.22, 1, 0.36, 1], delay: 0.3 }}
          className="font-display text-center leading-[0.85] text-[clamp(32px,5.4vw,64px)] mt-10 px-4"
        >
          80+ TOOLS.
          <br />
          <span className="inline-block bg-[#7BD3F7] border-[3px] border-black px-6 -rotate-2 rounded-lg shadow-[6px_6px_0_#000]">
            ONE OS.
          </span>
        </motion.h1>

        <Reveal delay={0.4}>
          <p className="mt-12 text-center text-[15px] lg:text-[17px] leading-relaxed text-black/70 max-w-2xl mx-auto px-6">
            Every capability runs from one connected workspace — message Ari
            on WhatsApp or open the dashboard. No learning curve. Just tell it
            what you need and it takes action.
          </p>
        </Reveal>

        <div className="absolute hidden md:block top-[140px] left-[5%]">
          <Sticker bg="#9BE7BF" rotate={-8} delay={0.6}>
            8 CATEGORIES
          </Sticker>
        </div>
        <div className="absolute hidden md:block top-[160px] right-[6%]">
          <Sticker bg="#FFE38C" rotate={9} delay={0.7} shape="tape">
            INFINITE COMBOS
          </Sticker>
        </div>

        <Reveal delay={0.5}>
          <div className="mt-10 flex flex-wrap justify-center gap-3 px-6">
            <span className="label-caps text-black/55">Control it from:</span>
            <span className="label-caps bg-[#9BE7BF] border-2 border-black px-3 py-1 rounded-full">
              WhatsApp + Dashboard
            </span>
          </div>
        </Reveal>
      </section>

      {/* CATEGORIES */}
      {categories.map((cat, catIdx) => (
        <section
          key={cat.name}
          className={`py-14 lg:py-20 overflow-hidden ${
            catIdx % 2 === 0 ? "bg-white" : "bg-[#FFFBED] border-y-[2.5px] border-black"
          }`}
        >
          <div className="max-w-[1300px] mx-auto px-6 lg:px-10">
            <Reveal>
              <div className="flex items-center gap-5 mb-12">
                <motion.div
                  whileHover={{ rotate: -8, scale: 1.05 }}
                  transition={{ type: "spring", stiffness: 220, damping: 12 }}
                  className="w-16 h-16 lg:w-20 lg:h-20 border-[2.5px] border-black flex items-center justify-center text-[34px] lg:text-[42px] flex-shrink-0"
                  style={{
                    background: cat.bg,
                    borderRadius: 14,
                    boxShadow: "5px 5px 0 #000",
                  }}
                >
                  {cat.emoji}
                </motion.div>
                <div>
                  <div className="label-caps text-black/55 mb-1">
                    Category {String(catIdx + 1).padStart(2, "0")}
                  </div>
                  <h2 className="font-body-big text-[28px] lg:text-[32px] leading-none">
                    {cat.name}
                  </h2>
                </div>
              </div>
            </Reveal>

            <div className="grid md:grid-cols-2 gap-5 lg:gap-6">
              {cat.features.map((f, i) => {
                const slug = slugByTitle.get(f.title);
                const card = (
                  <motion.div
                    whileHover={{ y: -4 }}
                    transition={{ type: "spring", stiffness: 220, damping: 15 }}
                    className="bg-white border-[2.5px] border-black p-5 h-full group"
                    style={{ borderRadius: 10, boxShadow: "5px 5px 0 #000" }}
                  >
                    <h3 className="font-body-big text-[15px] lg:text-[17px] mb-3">
                      {f.title}
                    </h3>
                    <p className="text-[15px] leading-relaxed text-black/70 mb-4">
                      {f.desc}
                    </p>
                    {slug && (
                      <span className="label-caps text-black inline-flex items-center gap-1 group-hover:gap-2 transition-all">
                        See use cases →
                      </span>
                    )}
                  </motion.div>
                );
                return (
                  <Reveal key={f.title} delay={i * 0.06}>
                    {slug ? (
                      <Link
                        href={`/preview-nudge/features/${slug}`}
                        className="block h-full"
                      >
                        {card}
                      </Link>
                    ) : (
                      card
                    )}
                  </Reveal>
                );
              })}
            </div>
          </div>
        </section>
      ))}

      {/* CTA */}
      <section className="py-10 lg:py-14 overflow-hidden">
        <div className="max-w-4xl mx-auto px-6 lg:px-10 text-center">
          <Reveal>
            <HandLabel text="ready?" width={80} className="mb-4" />
          </Reveal>
          <Reveal delay={0.1}>
            <h2 className="font-display text-[clamp(26px,4.4vw,46px)] leading-[0.88]">
              GET YOUR
              <br />
              <span className="inline-block bg-[#FFE38C] border-[3px] border-black px-6 -rotate-2 rounded-lg shadow-[6px_6px_0_#000]">
                TIME BACK.
              </span>
            </h2>
          </Reveal>
          <Reveal delay={0.2}>
            <p className="mt-10 text-[15px] lg:text-[16px] text-black/70 max-w-xl mx-auto">
              Start free on WhatsApp. Full access for your whole team — no plans, no cost.
            </p>
          </Reveal>
          <Reveal delay={0.3}>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
              <BlackPill href="http://127.0.0.1:43101">OPEN ARI DESKTOP</BlackPill>
              <OutlinePill href="/preview-nudge/meet">SEE MEETING RECORDER →</OutlinePill>
            </div>
          </Reveal>
        </div>
      </section>
    </PageShell>
  );
}
