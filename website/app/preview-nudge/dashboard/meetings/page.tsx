"use client";

import { useState } from "react";
import { DashboardShell, PageHead, Tabs, StatusPill } from "../_shell";

const meetings = [
  {
    title: "Pitch call — Sequoia",
    when: "Today, 10:30 AM",
    duration: "45 min",
    attendees: 4,
    platform: "Zoom",
    status: "upcoming",
    bot: true,
    color: "#7BD3F7",
  },
  {
    title: "Demo for Acme Corp",
    when: "Today, 4:30 PM",
    duration: "30 min",
    attendees: 6,
    platform: "Google Meet",
    status: "upcoming",
    bot: true,
    color: "#9BE7BF",
  },
  {
    title: "Q3 Planning",
    when: "Yesterday",
    duration: "1h 12 min",
    attendees: 5,
    platform: "Google Meet",
    status: "transcribed",
    actions: 8,
    decisions: 5,
    color: "#FFE38C",
  },
  {
    title: "1:1 with Priya — Marketing review",
    when: "2 days ago",
    duration: "32 min",
    attendees: 2,
    platform: "Zoom",
    status: "transcribed",
    actions: 4,
    decisions: 2,
    color: "#FFB1D8",
  },
  {
    title: "Engineering retro",
    when: "Last week",
    duration: "55 min",
    attendees: 7,
    platform: "Google Meet",
    status: "transcribed",
    actions: 11,
    decisions: 6,
    color: "#B7A8FF",
  },
];

const stats = [
  { label: "Meetings recorded", value: 47, accent: "#7BD3F7", hint: "this month" },
  { label: "Hours transcribed", value: "32h", accent: "#FFB1D8", hint: "total" },
  { label: "Action items extracted", value: 184, accent: "#FFE38C", hint: "auto-tasked" },
  { label: "Languages detected", value: 6, accent: "#9BE7BF", hint: "EN · HI · ES · FR · DE · JP" },
];

export default function MeetingsPage() {
  const [view, setView] = useState("upcoming");
  const upcoming = meetings.filter((m) => m.status === "upcoming");
  const past = meetings.filter((m) => m.status === "transcribed");
  const filtered = view === "upcoming" ? upcoming : past;

  return (
    <DashboardShell title="meetings">
      <PageHead
        title="Meetings"
        subtitle="Record system and microphone audio, then review the transcript, summary, decisions, suggestions, and complete report."
        badge={{ label: "Manual recorder · ready", color: "#3FAA6E" }}
        actions={
          <>
            <button className="dash-btn">Settings</button>
            <button className="dash-btn dash-btn-primary">+ Schedule</button>
          </>
        }
      />

      {/* Stats */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
        {stats.map((s) => (
          <div key={s.label} className="dash-card px-5 py-5 relative overflow-hidden">
            <span
              className="absolute top-0 left-0 right-0 h-[3px]"
              style={{ background: s.accent }}
            />
            <div className="dash-label">{s.label}</div>
            <div className="flex items-baseline gap-2 mt-3">
              <div className="num text-[26px] font-semibold tracking-tight leading-none">
                {s.value}
              </div>
              <div className="text-[11px] text-[#a3a3a3]">{s.hint}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <Tabs
          value={view}
          onChange={setView}
          options={[
            { value: "upcoming", label: "Upcoming", count: upcoming.length },
            { value: "past", label: "Past", count: past.length },
          ]}
        />
        <div className="flex items-center gap-2">
          <StatusPill color="#3FAA6E">Bot enabled</StatusPill>
        </div>
      </div>

      {/* Meeting list */}
      <section className="dash-card-hero overflow-hidden">
        <ul>
          {filtered.map((m, i) => (
            <li
              key={i}
              className={`px-6 py-5 hover:bg-[#fbfaf3] cursor-pointer transition-colors ${
                i !== filtered.length - 1 ? "border-b border-[#efece2]" : ""
              }`}
            >
              <div className="flex items-center gap-4">
                <div
                  className="w-10 h-10 rounded-lg border border-[#0a0a0a] flex items-center justify-center text-[14px] flex-shrink-0"
                  style={{ background: m.color }}
                >
                  🎥
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-semibold truncate">
                    {m.title}
                  </div>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap text-[11.5px] text-[#737373]">
                    <span className="num">{m.when}</span>
                    <span className="w-1 h-1 rounded-full bg-[#d4d4d4]" />
                    <span>{m.duration}</span>
                    <span className="w-1 h-1 rounded-full bg-[#d4d4d4]" />
                    <span>{m.attendees} attendees</span>
                    <span className="w-1 h-1 rounded-full bg-[#d4d4d4]" />
                    <span>{m.platform}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {m.status === "upcoming" && m.bot && (
                    <StatusPill color="#3FAA6E">Bot will join</StatusPill>
                  )}
                  {m.status === "transcribed" && (
                    <>
                      <StatusPill color="#FFE38C">
                        {m.actions} actions
                      </StatusPill>
                      <StatusPill color="#7BD3F7">
                        {m.decisions} decisions
                      </StatusPill>
                    </>
                  )}
                  <button className="dash-btn !py-1.5 !px-3 !text-[12px]">
                    {m.status === "upcoming" ? "Open" : "Read summary"}
                  </button>
                </div>
              </div>

              {m.status === "transcribed" && (
                <div className="mt-4 pl-14 text-[12.5px] text-[#525252] leading-relaxed line-clamp-2">
                  <span className="font-medium text-[#0a0a0a]">Key decisions:</span>{" "}
                  Hire 2 engineers · Delay launch by 2 weeks · Ship the new
                  onboarding experiment · Block off Friday for offsite prep…
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </DashboardShell>
  );
}
