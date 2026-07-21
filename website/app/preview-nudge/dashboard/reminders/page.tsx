"use client";

import { useState } from "react";
import { DashboardShell, PageHead, StatusPill, Tabs } from "../_shell";

const reminders = [
  { title: "Submit tax docs", when: "Today, 5:00 PM", recurring: "Every Friday", status: "active", category: "Personal" },
  { title: "Call dentist for cleaning appointment", when: "Tomorrow, 9:00 AM", recurring: null, status: "active", category: "Health" },
  { title: "Anniversary — book Italian place", when: "Mar 15, all day", recurring: null, status: "active", category: "Personal" },
  { title: "Take BP medication", when: "Daily, 8:00 AM", recurring: "Every day", status: "active", category: "Health" },
  { title: "Mom's birthday call", when: "Mar 28, 11:00 AM", recurring: "Yearly", status: "active", category: "Family" },
  { title: "Review Ari local app configuration", when: "Apr 02, all day", recurring: null, status: "snoozed", category: "Work" },
  { title: "Buy milk on the way home", when: "Today, when near home", recurring: null, status: "active", category: "Personal", location: true },
  { title: "Pay rent", when: "Mar 01, 10:00 AM", recurring: "Monthly", status: "done", category: "Personal" },
];

const categoryColor: Record<string, string> = {
  Personal: "#7BD3F7",
  Health: "#FFB1D8",
  Family: "#FFE38C",
  Work: "#9BE7BF",
};

export default function RemindersPage() {
  const [filter, setFilter] = useState("active");
  const counts = {
    active: reminders.filter((r) => r.status === "active").length,
    snoozed: reminders.filter((r) => r.status === "snoozed").length,
    done: reminders.filter((r) => r.status === "done").length,
  };
  const filtered =
    filter === "all" ? reminders : reminders.filter((r) => r.status === filter);

  return (
    <DashboardShell title="reminders">
      <PageHead
        title="Reminders"
        subtitle="One-time, recurring, location-based. Ari handles time zones, repeats, and nudges automatically."
        badge={{ label: "Reminders · 12 active", color: "#7BD3F7" }}
        actions={
          <>
            <button className="dash-btn">Import</button>
            <button className="dash-btn dash-btn-primary">+ New reminder</button>
          </>
        }
      />

      {/* Filter row */}
      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <Tabs
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: reminders.length },
            { value: "active", label: "Active", count: counts.active },
            { value: "snoozed", label: "Snoozed", count: counts.snoozed },
            { value: "done", label: "Done", count: counts.done },
          ]}
        />
        <div className="flex items-center gap-2 text-[12px] text-[#737373]">
          <span>Sort:</span>
          <button className="dash-btn !py-1 !px-2.5 !text-[12px]">Soonest first</button>
        </div>
      </div>

      {/* Hero list card */}
      <section className="dash-card-hero overflow-hidden">
        <ul>
          {filtered.map((r, i) => (
            <li
              key={i}
              className={`flex items-center gap-4 px-6 py-4 hover:bg-[#fbfaf3] transition-colors group ${
                i !== filtered.length - 1 ? "border-b border-[#efece2]" : ""
              }`}
            >
              <button
                className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-all ${
                  r.status === "done"
                    ? "bg-[#3FAA6E] border-[#3FAA6E] text-white"
                    : "border-[#d4d4d4] hover:border-[#0a0a0a]"
                }`}
              >
                {r.status === "done" && (
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                    <path
                      d="M3 6l2 2 4-4"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
              <div className="flex-1 min-w-0">
                <div
                  className={`text-[13.5px] font-medium truncate ${
                    r.status === "done" ? "line-through text-[#a3a3a3]" : "text-[#0a0a0a]"
                  }`}
                >
                  {r.title}
                </div>
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  <span className="text-[11.5px] text-[#737373] num">{r.when}</span>
                  {r.recurring && (
                    <>
                      <span className="w-1 h-1 rounded-full bg-[#d4d4d4]" />
                      <span className="text-[11px] text-[#737373] inline-flex items-center gap-1">
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                          <path
                            d="M2 5a4 4 0 016-2.5M10 7a4 4 0 01-6 2.5M9 1v3h-3M3 11v-3h3"
                            stroke="currentColor"
                            strokeWidth="1.4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                        {r.recurring}
                      </span>
                    </>
                  )}
                  {r.location && (
                    <>
                      <span className="w-1 h-1 rounded-full bg-[#d4d4d4]" />
                      <span className="text-[11px] text-[#737373] inline-flex items-center gap-1">
                        📍 Location
                      </span>
                    </>
                  )}
                </div>
              </div>
              <StatusPill color={categoryColor[r.category]}>
                {r.category}
              </StatusPill>
              <div className="opacity-0 group-hover:opacity-100 flex gap-1 transition-opacity">
                <button className="dash-btn !py-1 !px-2.5 !text-[11px]">Snooze</button>
                <button className="dash-btn !py-1 !px-2.5 !text-[11px]">Edit</button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <p className="text-[12px] text-[#a3a3a3] mt-4 text-center">
        Showing {filtered.length} of {reminders.length} reminders
      </p>
    </DashboardShell>
  );
}
