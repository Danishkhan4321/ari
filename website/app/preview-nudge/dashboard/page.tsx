"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import { DashboardShell, useLocalClock, StatusPill } from "./_shell";

const stats = [
  { label: "Reminders", value: 12, delta: "+3", deltaUp: true, hint: "vs yesterday", accent: "#7BD3F7" },
  { label: "Active tasks", value: 7, delta: "−2", deltaUp: false, hint: "vs yesterday", accent: "#FFE38C" },
  { label: "Unread email", value: 23, delta: "+8", deltaUp: true, hint: "since 8 AM", accent: "#FFB1D8" },
  { label: "Meetings today", value: 2, delta: "0", deltaUp: null, hint: "remaining", accent: "#9BE7BF" },
];

const today = [
  { time: "09:00", title: "Daily standup with product team", type: "Meeting", duration: "15 min", color: "#6366F1" },
  { time: "10:30", title: "Pitch call — Sequoia", type: "Meeting", duration: "45 min", color: "#6366F1" },
  { time: "12:00", title: "Reply to client about Q3 proposal", type: "Email", duration: "Today", color: "#EC4899" },
  { time: "14:00", title: "Submit expense report", type: "Task", duration: "Due today", color: "#F59E0B" },
  { time: "16:30", title: "Demo for Acme", type: "Meeting", duration: "30 min", color: "#6366F1" },
  { time: "18:00", title: "Call mom (recurring)", type: "Reminder", duration: "Daily", color: "#3FAA6E" },
];

const memories = [
  { kind: "Reminder", text: "Anniversary on March 15 — book the Italian place she loves", added: "2 days ago" },
  { kind: "Note", text: "Stripe takes 2.9% + $0.30 per transaction; Razorpay 2% flat", added: "5 days ago" },
  { kind: "Contact", text: "Raj — Product Lead at Meridian, met at TechCrunch '25", added: "1 week ago" },
  { kind: "Memory", text: "Mom's blood group is O+, allergic to penicillin", added: "2 weeks ago" },
];

export default function DashboardOverview() {
  const { time, date } = useLocalClock();
  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 17) return "Good afternoon";
    return "Good evening";
  })();

  return (
    <DashboardShell title="overview">
      {/* Hero */}
      <div className="flex items-end justify-between flex-wrap gap-6 mb-12">
        <div>
          <div className="dash-label mb-3">Today · {date}</div>
          <h1 className="dash-h1 text-[28px]">{greeting}, Danish</h1>
          <p className="text-[13.5px] text-[#737373] mt-2.5 leading-relaxed">
            You have <span className="text-[#0a0a0a] font-medium">2 meetings</span>,{" "}
            <span className="text-[#0a0a0a] font-medium">7 tasks</span>, and{" "}
            <span className="text-[#0a0a0a] font-medium">23 unread emails</span>.
          </p>
        </div>
        <div
          className="px-4 py-2 flex items-center gap-3 bg-[#FFE38C] border border-[#0a0a0a]"
          style={{ borderRadius: 8, boxShadow: "3px 3px 0 #0a0a0a" }}
        >
          <span className="text-[12.5px] font-semibold num">{time}</span>
          <span className="w-px h-3 bg-[#0a0a0a]/30" />
          <span className="flex items-center gap-1.5 text-[11px] font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-[#3FAA6E]" />
            Synced
          </span>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {stats.map((s, i) => (
          <motion.div
            key={s.label}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            whileHover={{ y: -2 }}
            transition={{ delay: i * 0.04, duration: 0.3 }}
            className="dash-card px-5 py-5 relative overflow-hidden cursor-default"
          >
            <span
              className="absolute top-0 left-0 right-0 h-[3px]"
              style={{ background: s.accent }}
            />
            <div className="flex items-start justify-between">
              <div className="dash-label">{s.label}</div>
              {s.deltaUp !== null && (
                <span
                  className={`text-[11px] font-medium num ${
                    s.deltaUp ? "text-[#3FAA6E]" : "text-[#a3a3a3]"
                  }`}
                >
                  {s.delta}
                </span>
              )}
            </div>
            <div className="flex items-baseline gap-2 mt-4">
              <div className="num text-[30px] font-semibold tracking-tight leading-none">
                {s.value}
              </div>
              <div className="text-[11px] text-[#a3a3a3]">{s.hint}</div>
            </div>
          </motion.div>
        ))}
      </div>

      {/* Two column */}
      <div className="grid lg:grid-cols-[1.6fr,1fr] gap-5 mt-10">
        {/* Agenda hero */}
        <section className="dash-card-hero overflow-hidden">
          <div className="px-6 py-5 border-b border-[#0a0a0a]/15 flex items-center justify-between">
            <h2 className="dash-h2">Today&apos;s agenda</h2>
            <Link
              href="/preview-nudge/dashboard/calendar"
              className="text-[12px] text-[#737373] hover:text-[#0a0a0a] transition-colors"
            >
              View week
            </Link>
          </div>
          <ul>
            {today.map((item, i) => (
              <li
                key={i}
                className={`flex items-center gap-5 px-6 py-4 hover:bg-[#fbfaf3] transition-colors cursor-pointer group ${
                  i !== today.length - 1 ? "border-b border-[#efece2]" : ""
                }`}
              >
                <div className="num text-[12px] text-[#737373] w-12 flex-shrink-0 font-medium">
                  {item.time}
                </div>
                <span
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ background: item.color }}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-[13.5px] font-medium text-[#0a0a0a] truncate">
                    {item.title}
                  </div>
                  <div className="text-[11.5px] text-[#737373] mt-1">
                    {item.type} · {item.duration}
                  </div>
                </div>
                <button
                  className="opacity-0 group-hover:opacity-100 dash-btn !py-1.5 !px-2.5 !text-[11px] transition-opacity"
                  aria-label="Mark done"
                >
                  Done
                </button>
              </li>
            ))}
          </ul>
        </section>

        {/* Right column */}
        <div className="space-y-5">
          {/* Quick capture */}
          <section
            className="bg-[#0E0E0C] text-white p-5 border border-[#0a0a0a]"
            style={{ borderRadius: 12, boxShadow: "4px 4px 0 #0a0a0a" }}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="dash-h2 text-white flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[#7BD3F7] animate-pulse" />
                Ask Ari
              </h3>
              <span className="text-[10px] text-white/55 uppercase tracking-wider">
                ⌘ K
              </span>
            </div>
            <input
              type="text"
              placeholder="Remind me to call mom at 6 PM…"
              className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2.5 text-[13px] text-white placeholder:text-white/40 outline-none focus:border-[#7BD3F7] transition-colors"
            />
            <div className="flex flex-wrap gap-1.5 mt-3.5">
              {[
                { label: "Schedule", color: "#7BD3F7" },
                { label: "Email", color: "#FFB1D8" },
                { label: "Task", color: "#FFE38C" },
                { label: "Save", color: "#9BE7BF" },
              ].map((q) => (
                <button
                  key={q.label}
                  className="text-[11px] font-medium text-white/80 bg-white/5 border border-white/15 hover:bg-white/10 hover:border-white/30 px-2.5 py-1 rounded inline-flex items-center gap-1.5 transition-colors"
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: q.color }}
                  />
                  {q.label}
                </button>
              ))}
            </div>
          </section>

          {/* Recent memory */}
          <section className="dash-card overflow-hidden">
            <div className="px-5 py-4 border-b border-[#e8e6dc] flex items-center justify-between">
              <h3 className="dash-h2">Recent memory</h3>
              <Link
                href="/preview-nudge/dashboard/memory"
                className="text-[11px] text-[#737373] num hover:text-[#0a0a0a]"
              >
                412
              </Link>
            </div>
            <ul>
              {memories.map((m, i) => (
                <li
                  key={i}
                  className={`px-5 py-4 hover:bg-[#fbfaf3] cursor-pointer transition-colors ${
                    i !== memories.length - 1 ? "border-b border-[#efece2]" : ""
                  }`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[10px] font-medium text-[#737373] uppercase tracking-wider">
                      {m.kind}
                    </span>
                    <span className="w-1 h-1 rounded-full bg-[#d4d4d4]" />
                    <span className="text-[11px] text-[#a3a3a3]">{m.added}</span>
                  </div>
                  <div className="text-[12.5px] leading-relaxed text-[#404040]">
                    {m.text}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </DashboardShell>
  );
}
