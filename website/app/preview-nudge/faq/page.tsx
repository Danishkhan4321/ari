"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  PageShell,
  Reveal,
  HandLabel,
  Sticker,
  BlackPill,
  OutlinePill,
} from "../_shared";

const faqCategories = [
  {
    title: "Getting Started",
    bg: "#7BD3F7",
    emoji: "🚀",
    faqs: [
      { q: "What is Ari?", a: "Ari is your agentic operating system for work — an AI-powered work management platform that brings leads and outreach, team and task management, meetings, reminders, and daily operations into one connected workspace. It understands the context of your work and takes action on your behalf, across 80+ capabilities. Control it from WhatsApp or the web dashboard." },
      { q: "Do I need to install anything?", a: "For this local preview, open Ari Desktop on this computer. You can also control Ari from WhatsApp once that integration is configured." },
      { q: "How do I get started?", a: "Three steps: 1) Message Ari on WhatsApp or open the dashboard. 2) Connect your Google or Microsoft account for calendar and email. 3) Start telling it what you need. \"Build a lead list…\" \"Schedule a meeting…\" \"Assign this task…\" That's it." },
      { q: "Is Ari free?", a: "Yes — completely free. Every feature and the full productivity stack (email, calendar, tasks, meetings, teams) is unlocked for everyone. No paid plans, no upgrades, no credit card required." },
    ],
  },
  {
    title: "Features & Capabilities",
    bg: "#FFE38C",
    emoji: "⚡",
    faqs: [
      { q: "What can Ari actually do?", a: "80+ AI tools across 8 categories: Memory & Reminders, Calendar, Email, Tasks, Team, Sales/CRM, Meetings, and Personal Productivity. Each works through natural conversation on WhatsApp — or from the web dashboard." },
      { q: "How does the Meeting Recorder work?", a: "You explicitly start recording from Ari Desktop. Ari captures system and microphone audio, transcribes it with renameable speaker labels, and generates summaries, decisions, action items, task suggestions, and a complete report. Suggested tasks require your confirmation." },
      { q: "Can Ari manage my team?", a: "Yes. Team features are fully available to everyone: automated standups, task assignment, leave management, polls, shared calendars, and team dashboards — no plan required." },
      { q: "Does Ari work with my existing tools?", a: "Yes. Integrations include Google Calendar, Gmail, Outlook, Apple Calendar, Google Meet, Zoom, and Drive. More are added monthly." },
      { q: "Is there a dashboard, or is it only chat?", a: "Both. Chat is the primary surface, and Ari Desktop includes the full dashboard. You can run everything from there — daily briefing, full chat history, reminders, tasks & sprints (kanban), contacts & CRM, sales pipeline, inbox, meetings with transcripts, notes & knowledge base, team standups, productivity (focus, habits, expenses), campaigns, smart groups, calendar, and settings. Same data, two surfaces." },
      { q: "How does the CRM compare to Folk or HubSpot?", a: "Lighter than HubSpot, more conversational than Folk. You get contact lists, a drag-drop sales pipeline (New → Qualified → Demo → Negotiation → Won), smart segments (VIPs, investors, beta testers), and campaign tracking with open/click/reply rates. The kicker: every contact and deal can be created or updated from WhatsApp or the dashboard by just typing." },
    ],
  },
  {
    title: "Platforms & Languages",
    bg: "#FFB1D8",
    emoji: "🌐",
    faqs: [
      { q: "Where can I use Ari?", a: "Use Ari Desktop locally or control Ari from WhatsApp once that integration is configured — one platform and one connected context." },
      { q: "Can I use Ari in Hindi or other languages?", a: "Yes. Ari detects your language automatically and supports 100+ languages. Hindi conversations are auto-transliterated to Hinglish for readability. Meeting transcriptions work in all supported languages with speaker labels." },
    ],
  },
  {
    title: "Security & Privacy",
    bg: "#9BE7BF",
    emoji: "🔒",
    faqs: [
      { q: "Is my data safe?", a: "All OAuth tokens are encrypted at rest using AES-256. SSRF protection is enforced on external calls. Rate limiting prevents abuse. We never store passwords. All data is transmitted over HTTPS." },
      { q: "Can Ari read my emails?", a: "Ari only accesses emails when you explicitly ask. It doesn't passively scan your inbox. When you say \"Show me important emails,\" it queries your Gmail/Outlook via OAuth and returns results in real time. No permanent email storage." },
      { q: "What happens if I delete my account?", a: "All your data is permanently deleted within 30 days. Reminders, memories, notes, contacts, conversation history, and any connected account tokens. We don't retain anything." },
    ],
  },
  {
    title: "Cost & Access",
    bg: "#B7A8FF",
    emoji: "💸",
    textColor: "white",
    faqs: [
      { q: "How much does Ari cost?", a: "Nothing. Ari is completely free — every feature, full access, no paid plans and no billing." },
      { q: "Are there different plans or tiers?", a: "No. There are no tiers and no upgrades. Everyone gets the entire product, including team features and the meeting recorder." },
      { q: "Do I need a credit card?", a: "Never. Just message Ari on WhatsApp or open the dashboard and start using everything right away — no payment details required, ever." },
    ],
  },
];

function FAQItem({ q, a, idx }: { q: string; a: string; idx: number }) {
  const [open, setOpen] = useState(false);
  return (
    <motion.button
      whileHover={{ x: 4 }}
      onClick={() => setOpen(!open)}
      className="w-full text-left bg-white border-[2.5px] border-black p-6 transition-all"
      style={{ borderRadius: 12, boxShadow: "5px 5px 0 #000" }}
    >
      <div className="flex items-center justify-between gap-4">
        <span className="font-body-big text-[14px] lg:text-[16px] leading-tight">
          {q}
        </span>
        <span
          className={`w-10 h-10 rounded-full border-2 border-black flex items-center justify-center flex-shrink-0 font-bold text-xl transition-all ${
            open ? "bg-[#FFE38C] rotate-45" : "bg-white"
          }`}
        >
          +
        </span>
      </div>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="overflow-hidden"
          >
            <p className="mt-4 text-[15px] leading-relaxed text-black/70">{a}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.button>
  );
}

export default function FaqNudge() {
  return (
    <PageShell>
      {/* HERO */}
      <section className="relative pt-12 pb-32 lg:pb-40 overflow-hidden">
        <Reveal className="text-center">
          <HandLabel text="ask anything!" width={150} />
        </Reveal>

        <motion.h1
          initial={{ opacity: 0, scale: 0.92, y: 40 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 1, ease: [0.22, 1, 0.36, 1], delay: 0.3 }}
          className="font-display text-center leading-[0.85] text-[clamp(32px,5.4vw,64px)] mt-10 px-4"
        >
          QUESTIONS?
          <br />
          <span className="inline-block bg-[#FFB1D8] border-[3px] border-black px-6 -rotate-2 rounded-lg shadow-[6px_6px_0_#000]">
            ANSWERED.
          </span>
        </motion.h1>

        <Reveal delay={0.4}>
          <p className="mt-12 text-center text-[15px] lg:text-[17px] leading-relaxed text-black/70 max-w-2xl mx-auto px-6">
            Everything you need to know about Ari — from setup to security
            to billing. Can&apos;t find your answer? Message us on WhatsApp.
          </p>
        </Reveal>

        <div className="absolute hidden md:block top-[140px] left-[5%]">
          <Sticker bg="#9BE7BF" rotate={-10} delay={0.6}>
            5 CATEGORIES
          </Sticker>
        </div>
        <div className="absolute hidden md:block top-[160px] right-[6%]">
          <Sticker bg="#7BD3F7" rotate={9} delay={0.7} shape="tape">
            19 ANSWERS
          </Sticker>
        </div>
      </section>

      {/* CATEGORIES */}
      {faqCategories.map((cat, catIdx) => (
        <section
          key={cat.title}
          className={`py-14 lg:py-20 overflow-hidden ${
            catIdx % 2 === 0 ? "bg-white" : "bg-[#FFFBED] border-y-[2.5px] border-black"
          }`}
        >
          <div className="max-w-3xl mx-auto px-6 lg:px-10">
            <Reveal>
              <div className="flex items-center gap-5 mb-12">
                <motion.div
                  whileHover={{ rotate: -8, scale: 1.05 }}
                  transition={{ type: "spring", stiffness: 220, damping: 12 }}
                  className="w-14 h-14 lg:w-16 lg:h-16 border-[2.5px] border-black flex items-center justify-center text-[26px] lg:text-[32px] flex-shrink-0"
                  style={{
                    background: cat.bg,
                    borderRadius: 12,
                    boxShadow: "4px 4px 0 #000",
                  }}
                >
                  {cat.emoji}
                </motion.div>
                <div>
                  <div className="label-caps text-black/55 mb-1">
                    Section {String(catIdx + 1).padStart(2, "0")}
                  </div>
                  <h2 className="font-body-big text-[26px] lg:text-[36px] leading-none">
                    {cat.title}
                  </h2>
                </div>
              </div>
            </Reveal>

            <div className="space-y-4">
              {cat.faqs.map((f, i) => (
                <Reveal key={f.q} delay={i * 0.06}>
                  <FAQItem q={f.q} a={f.a} idx={i} />
                </Reveal>
              ))}
            </div>
          </div>
        </section>
      ))}

      {/* CTA */}
      <section className="py-10 lg:py-14 overflow-hidden">
        <div className="max-w-4xl mx-auto px-6 lg:px-10 text-center">
          <Reveal>
            <HandLabel text="still curious?" width={150} className="mb-4" />
          </Reveal>
          <Reveal delay={0.1}>
            <h2 className="font-display text-[clamp(24px,4vw,40px)] leading-[0.88]">
              JUST ASK
              <br />
              <span className="inline-block bg-[#9BE7BF] border-[3px] border-black px-6 -rotate-2 rounded-lg shadow-[6px_6px_0_#000]">
                ARI.
              </span>
            </h2>
          </Reveal>
          <Reveal delay={0.2}>
            <p className="mt-10 text-[15px] lg:text-[16px] text-black/70">
              Yes, the AI answers FAQs too. Message Ari directly on WhatsApp.
            </p>
          </Reveal>
          <Reveal delay={0.3}>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
              <BlackPill href="http://127.0.0.1:43101">OPEN ARI DESKTOP</BlackPill>
              <OutlinePill href="/preview-nudge/features">EXPLORE FEATURES →</OutlinePill>
            </div>
          </Reveal>
        </div>
      </section>
    </PageShell>
  );
}
