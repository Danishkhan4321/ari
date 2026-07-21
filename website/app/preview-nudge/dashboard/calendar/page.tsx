"use client";

import { useState } from "react";
import { DashboardShell, PageHead, Tabs, StatusPill } from "../_shell";

const events = [
  { day: 0, time: "09:00", end: "09:15", title: "Daily standup", source: "Google", color: "#7BD3F7" },
  { day: 0, time: "10:30", end: "11:15", title: "Pitch — Sequoia", source: "Google", color: "#FFB1D8" },
  { day: 0, time: "16:30", end: "17:00", title: "Demo for Acme", source: "Google", color: "#9BE7BF" },
  { day: 1, time: "11:00", end: "12:00", title: "Q3 planning", source: "Outlook", color: "#FFE38C" },
  { day: 1, time: "14:00", end: "14:30", title: "1:1 with Priya", source: "Google", color: "#7BD3F7" },
  { day: 2, time: "09:30", end: "10:00", title: "Team retro", source: "Google", color: "#9BE7BF" },
  { day: 2, time: "15:00", end: "16:00", title: "Sales kickoff", source: "Google", color: "#B7A8FF" },
  { day: 3, time: "10:00", end: "10:30", title: "Design review", source: "Google", color: "#FFB1D8" },
  { day: 4, time: "13:00", end: "14:00", title: "Lunch with Raj", source: "Apple", color: "#FF9D6E" },
  { day: 5, time: "11:00", end: "12:00", title: "Office hours", source: "Google", color: "#9BE7BF" },
];

const days = [
  { label: "Mon", date: 28 },
  { label: "Tue", date: 29 },
  { label: "Wed", date: 30 },
  { label: "Thu", date: 1 },
  { label: "Fri", date: 2 },
  { label: "Sat", date: 3 },
  { label: "Sun", date: 4 },
];

const hours = Array.from({ length: 11 }, (_, i) => 8 + i); // 8am - 6pm

export default function CalendarPage() {
  const [view, setView] = useState("week");
  const today = 0;

  return (
    <DashboardShell title="calendar">
      <PageHead
        title="Calendar"
        subtitle="Google + Outlook + Apple, unified into one view. Create events with a sentence."
        badge={{ label: "3 calendars synced", color: "#9BE7BF" }}
        actions={
          <>
            <button className="dash-btn">← Today</button>
            <button className="dash-btn dash-btn-primary">+ New event</button>
          </>
        }
      />

      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <div className="flex items-center gap-3">
          <Tabs
            value={view}
            onChange={setView}
            options={[
              { value: "day", label: "Day" },
              { value: "week", label: "Week" },
              { value: "month", label: "Month" },
            ]}
          />
          <div className="text-[14px] font-semibold text-[#0a0a0a]">
            Apr 28 — May 4, 2026
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <StatusPill color="#7BD3F7">Google</StatusPill>
          <StatusPill color="#FFE38C">Outlook</StatusPill>
          <StatusPill color="#FF9D6E">Apple</StatusPill>
        </div>
      </div>

      {/* Week grid hero */}
      <section className="dash-card-hero overflow-hidden">
        {/* Day header */}
        <div className="grid grid-cols-[60px_repeat(7,1fr)] border-b border-[#0a0a0a]/15">
          <div className="px-2 py-3 dash-label text-center">UTC</div>
          {days.map((d, i) => (
            <div
              key={d.label}
              className={`px-3 py-3 border-l border-[#0a0a0a]/10 ${
                i === today ? "bg-[#FFE38C]/30" : ""
              }`}
            >
              <div className="dash-label">{d.label}</div>
              <div
                className={`text-[20px] font-semibold mt-0.5 num ${
                  i === today ? "text-[#0a0a0a]" : "text-[#525252]"
                }`}
              >
                {d.date}
              </div>
            </div>
          ))}
        </div>

        {/* Time grid */}
        <div className="grid grid-cols-[60px_repeat(7,1fr)] relative">
          {/* Hours column */}
          <div>
            {hours.map((h) => (
              <div
                key={h}
                className="h-14 border-b border-[#efece2] flex items-start justify-end pr-2 pt-1"
              >
                <span className="text-[10px] text-[#a3a3a3] num">
                  {h % 12 || 12} {h >= 12 ? "PM" : "AM"}
                </span>
              </div>
            ))}
          </div>
          {/* Day columns */}
          {days.map((_, dayIdx) => (
            <div
              key={dayIdx}
              className={`relative border-l border-[#efece2] ${
                dayIdx === today ? "bg-[#FFE38C]/10" : ""
              }`}
            >
              {hours.map((h) => (
                <div
                  key={h}
                  className="h-14 border-b border-[#efece2]"
                />
              ))}
              {/* Events for this day */}
              {events
                .filter((e) => e.day === dayIdx)
                .map((e, i) => {
                  const [eh, em] = e.time.split(":").map(Number);
                  const [endH, endM] = e.end.split(":").map(Number);
                  const startMin = (eh - 8) * 60 + em;
                  const durMin = (endH - eh) * 60 + (endM - em);
                  return (
                    <button
                      key={i}
                      className="absolute left-1 right-1 px-2 py-1.5 rounded-md text-left overflow-hidden border border-[#0a0a0a] hover:translate-y-[-1px] transition-transform"
                      style={{
                        top: `${(startMin / 60) * 56 + 2}px`,
                        height: `${(durMin / 60) * 56 - 4}px`,
                        background: e.color,
                      }}
                    >
                      <div className="text-[10px] font-medium num text-[#0a0a0a]/65">
                        {e.time}
                      </div>
                      <div className="text-[11.5px] font-semibold leading-tight truncate">
                        {e.title}
                      </div>
                    </button>
                  );
                })}
              {/* Now indicator on today */}
              {dayIdx === today && (
                <div
                  className="absolute left-0 right-0 h-px bg-[#ef4444]"
                  style={{ top: "200px" }}
                >
                  <span className="absolute -left-1 -top-1 w-2 h-2 rounded-full bg-[#ef4444]" />
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Up next */}
      <section className="dash-card mt-6 overflow-hidden">
        <div className="px-6 py-5 border-b border-[#e8e6dc] flex items-center justify-between">
          <h2 className="dash-h2">Up next</h2>
          <span className="text-[11px] text-[#737373]">Across all calendars</span>
        </div>
        <ul>
          {events.slice(0, 4).map((e, i) => (
            <li
              key={i}
              className={`flex items-center gap-5 px-6 py-4 hover:bg-[#fbfaf3] cursor-pointer ${
                i !== 3 ? "border-b border-[#efece2]" : ""
              }`}
            >
              <div className="w-1 h-10 rounded-full" style={{ background: e.color }} />
              <div className="flex-1 min-w-0">
                <div className="text-[13.5px] font-medium truncate">{e.title}</div>
                <div className="text-[11.5px] text-[#737373] mt-0.5 num">
                  {days[e.day].label} · {e.time} – {e.end}
                </div>
              </div>
              <span className="text-[10px] uppercase tracking-wider text-[#737373] font-medium">
                {e.source}
              </span>
              <button className="dash-btn !py-1 !px-2.5 !text-[11px]">Open</button>
            </li>
          ))}
        </ul>
      </section>
    </DashboardShell>
  );
}
