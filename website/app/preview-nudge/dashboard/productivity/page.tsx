"use client";

import { DashboardShell, PageHead, Tabs, StatusPill } from "../_shell";
import { useState } from "react";

const stats = [
  { label: "Focus time",    value: "4h 32m", accent: "#7BD3F7", hint: "Today" },
  { label: "Tasks done",    value: 14,        accent: "#9BE7BF", hint: "+5 vs yesterday" },
  { label: "Habit streak",  value: "21 d",   accent: "#FFE38C", hint: "Meditation" },
  { label: "Deep work",     value: "62%",    accent: "#FFB1D8", hint: "of work hours" },
];

const habits = [
  { name: "Meditation",        streak: 21, today: true,  color: "#9BE7BF", emoji: "🧘" },
  { name: "8 hours of sleep",  streak: 12, today: true,  color: "#7BD3F7", emoji: "🌙" },
  { name: "Read 30 minutes",   streak: 9,  today: false, color: "#FFE38C", emoji: "📖" },
  { name: "Workout",           streak: 6,  today: true,  color: "#FFB1D8", emoji: "🏋️" },
  { name: "Inbox zero",        streak: 3,  today: false, color: "#FF9D6E", emoji: "✉️" },
];

const focusBlocks = [
  { time: "09:00 – 10:30", title: "Deep work · Q3 GTM doc", color: "#7BD3F7", duration: "1h 30m" },
  { time: "11:00 – 11:25", title: "Pomodoro · Email triage", color: "#FFE38C", duration: "25m" },
  { time: "13:30 – 15:00", title: "Deep work · Investor deck", color: "#7BD3F7", duration: "1h 30m" },
  { time: "15:30 – 16:00", title: "Pomodoro · Code review",   color: "#FFE38C", duration: "30m" },
];

const expenses = [
  { date: "Today", desc: "Lunch — team",        amount: "₹1,240",  category: "Food",     color: "#FF9D6E" },
  { date: "Today", desc: "Uber — airport",      amount: "₹680",    category: "Travel",   color: "#7BD3F7" },
  { date: "Yest",  desc: "AWS — May invoice",   amount: "$284.12", category: "Tools",    color: "#9BE7BF" },
  { date: "Yest",  desc: "Coffee · Blue Tokai", amount: "₹420",    category: "Food",     color: "#FF9D6E" },
  { date: "Mon",   desc: "Notion — annual",     amount: "$96",     category: "Tools",    color: "#9BE7BF" },
];

export default function ProductivityPage() {
  const [tab, setTab] = useState("today");

  return (
    <DashboardShell title="productivity">
      <PageHead
        title="Productivity"
        subtitle="Focus time, habits, expenses — your personal operating dashboard. Ari tracks it as you go."
        badge={{ label: "Productivity · live", color: "#3FAA6E" }}
        actions={
          <>
            <button className="dash-btn">Export</button>
            <button className="dash-btn dash-btn-primary">▶ Start focus</button>
          </>
        }
      />

      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: "today", label: "Today" },
          { value: "week",  label: "This week" },
          { value: "month", label: "This month" },
        ]}
      />

      {/* KPI strip */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5 mt-6 mb-8">
        {stats.map((s) => (
          <div key={s.label} className="dash-card px-5 py-5 relative overflow-hidden">
            <span className="absolute top-0 left-0 right-0 h-[3px]" style={{ background: s.accent }} />
            <div className="dash-label">{s.label}</div>
            <div className="flex items-baseline gap-2 mt-3">
              <div className="num text-[26px] font-semibold tracking-tight leading-none">{s.value}</div>
              <div className="text-[11px] text-[#a3a3a3]">{s.hint}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid lg:grid-cols-[1.4fr,1fr] gap-5">
        {/* Habits — hero */}
        <section className="dash-card-hero overflow-hidden">
          <div className="px-6 py-5 border-b border-[#0a0a0a]/15 flex items-center justify-between">
            <h2 className="dash-h2">Habits</h2>
            <button className="text-[12px] text-[#737373] hover:text-[#0a0a0a]">+ Add habit</button>
          </div>
          <ul>
            {habits.map((h, i) => (
              <li
                key={i}
                className={`flex items-center gap-4 px-6 py-4 hover:bg-[#fbfaf3] cursor-pointer ${
                  i !== habits.length - 1 ? "border-b border-[#efece2]" : ""
                }`}
              >
                <button
                  className={`w-9 h-9 rounded-md border-2 flex items-center justify-center text-[16px] flex-shrink-0 transition-colors ${
                    h.today
                      ? "border-[#0a0a0a]"
                      : "border-[#d4d4d4] hover:border-[#0a0a0a]"
                  }`}
                  style={h.today ? { background: h.color } : {}}
                >
                  {h.today ? "✓" : h.emoji}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="text-[13.5px] font-medium">{h.name}</div>
                  <div className="text-[11.5px] text-[#737373] mt-0.5 num">
                    {h.streak} day streak {h.today && "· done today"}
                  </div>
                </div>
                <div className="flex gap-0.5">
                  {Array.from({ length: 7 }).map((_, day) => (
                    <span
                      key={day}
                      className={`w-3.5 h-3.5 rounded-sm ${
                        day < h.streak % 7 ? "" : "bg-[#efece2]"
                      }`}
                      style={day < h.streak % 7 ? { background: h.color } : {}}
                    />
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* Right: Focus blocks + Expenses */}
        <div className="space-y-5">
          <section className="dash-card overflow-hidden">
            <div className="px-5 py-4 border-b border-[#e8e6dc] flex items-center justify-between">
              <h3 className="dash-h2">Focus blocks today</h3>
              <span className="text-[11px] text-[#737373] num">3h 55m total</span>
            </div>
            <ul>
              {focusBlocks.map((f, i) => (
                <li
                  key={i}
                  className={`flex items-center gap-4 px-5 py-3.5 hover:bg-[#fbfaf3] ${
                    i !== focusBlocks.length - 1 ? "border-b border-[#efece2]" : ""
                  }`}
                >
                  <div className="w-1 h-9 rounded-full" style={{ background: f.color }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] font-medium truncate">{f.title}</div>
                    <div className="text-[11px] text-[#737373] num mt-0.5">{f.time}</div>
                  </div>
                  <span className="text-[11px] text-[#a3a3a3] num flex-shrink-0">{f.duration}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="dash-card overflow-hidden">
            <div className="px-5 py-4 border-b border-[#e8e6dc] flex items-center justify-between">
              <h3 className="dash-h2">Recent expenses</h3>
              <span className="text-[11px] text-[#a3a3a3]">View all</span>
            </div>
            <ul>
              {expenses.map((e, i) => (
                <li
                  key={i}
                  className={`flex items-center gap-3 px-5 py-3 hover:bg-[#fbfaf3] ${
                    i !== expenses.length - 1 ? "border-b border-[#efece2]" : ""
                  }`}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{ background: e.color }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] font-medium truncate">{e.desc}</div>
                    <div className="text-[10.5px] text-[#a3a3a3]">{e.date} · {e.category}</div>
                  </div>
                  <span className="text-[12.5px] num font-medium">{e.amount}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </DashboardShell>
  );
}
