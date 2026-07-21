"use client";

import { useState } from "react";
import { DashboardShell, PageHead, Tabs, StatusPill } from "../_shell";

const cols = [
  { id: "todo", label: "To do", accent: "#7BD3F7" },
  { id: "inprogress", label: "In progress", accent: "#FFE38C" },
  { id: "review", label: "Review", accent: "#FFB1D8" },
  { id: "done", label: "Done", accent: "#9BE7BF" },
] as const;

type Priority = "low" | "med" | "high";

const tasksData: Record<
  string,
  { title: string; due: string; priority: Priority; assignee: string; tag: string }[]
> = {
  todo: [
    { title: "Submit expense report for April", due: "Today", priority: "high", assignee: "AT", tag: "Personal" },
    { title: "Review Q3 budget proposal", due: "Friday", priority: "med", assignee: "AT", tag: "Finance" },
    { title: "Draft launch announcement email", due: "Mon", priority: "med", assignee: "AT", tag: "Marketing" },
    { title: "Review Ari local app configuration", due: "Apr 02", priority: "low", assignee: "AT", tag: "Ops" },
  ],
  inprogress: [
    { title: "Finalize landing page copy", due: "Wed", priority: "high", assignee: "AT", tag: "Marketing" },
    { title: "Onboard new designer", due: "This week", priority: "med", assignee: "PR", tag: "People" },
  ],
  review: [
    { title: "Pricing page layout v3", due: "Today", priority: "high", assignee: "RJ", tag: "Design" },
  ],
  done: [
    { title: "Ship Stripe billing integration", due: "Last week", priority: "high", assignee: "AT", tag: "Engineering" },
    { title: "Send investor update", due: "Mon", priority: "med", assignee: "AT", tag: "Investor" },
  ],
};

const priorityColor: Record<Priority, string> = {
  high: "#ef4444",
  med: "#F59E0B",
  low: "#a3a3a3",
};

export default function TasksPage() {
  const [view, setView] = useState("board");
  const total = Object.values(tasksData).flat().length;

  return (
    <DashboardShell title="tasks">
      <PageHead
        title="Tasks"
        subtitle="Add, assign, prioritize, and track tasks. Managed entirely through chat — board view stays in sync."
        badge={{ label: `${total} active across boards`, color: "#FFE38C" }}
        actions={
          <>
            <button className="dash-btn">Filters</button>
            <button className="dash-btn dash-btn-primary">+ New task</button>
          </>
        }
      />

      <div className="flex items-center justify-between flex-wrap gap-3 mb-6">
        <Tabs
          value={view}
          onChange={setView}
          options={[
            { value: "board", label: "Board" },
            { value: "list", label: "List" },
            { value: "timeline", label: "Timeline" },
          ]}
        />
        <div className="flex items-center gap-2">
          <StatusPill color="#ef4444">3 high</StatusPill>
          <StatusPill color="#F59E0B">3 medium</StatusPill>
          <StatusPill color="#a3a3a3">2 low</StatusPill>
        </div>
      </div>

      {/* Kanban */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cols.map((col) => (
          <div key={col.id} className="dash-card overflow-hidden flex flex-col">
            <div className="px-4 py-3 border-b border-[#e8e6dc] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ background: col.accent }}
                />
                <span className="text-[12.5px] font-semibold">{col.label}</span>
                <span className="text-[11px] text-[#a3a3a3] num">
                  {tasksData[col.id].length}
                </span>
              </div>
              <button className="text-[#a3a3a3] hover:text-[#0a0a0a]">+</button>
            </div>
            <div className="p-3 space-y-2 flex-1">
              {tasksData[col.id].map((t, i) => (
                <article
                  key={i}
                  className="bg-white border border-[#e8e6dc] rounded-lg p-3 hover:border-[#0a0a0a] hover:shadow-[2px_2px_0_#0a0a0a] cursor-grab active:cursor-grabbing transition-all"
                >
                  <div className="flex items-center gap-1.5 mb-2">
                    <span
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ background: priorityColor[t.priority] }}
                    />
                    <span className="text-[10px] uppercase tracking-wider font-medium text-[#737373]">
                      {t.tag}
                    </span>
                  </div>
                  <div className="text-[13px] font-medium leading-snug text-[#0a0a0a]">
                    {t.title}
                  </div>
                  <div className="flex items-center justify-between mt-3">
                    <span className="text-[11px] text-[#737373] num">{t.due}</span>
                    <div className="w-6 h-6 rounded-full bg-[#0a0a0a] text-white flex items-center justify-center text-[10px] font-bold">
                      {t.assignee}
                    </div>
                  </div>
                </article>
              ))}
              {tasksData[col.id].length === 0 && (
                <div className="text-[12px] text-[#a3a3a3] text-center py-6">
                  Drag tasks here
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </DashboardShell>
  );
}
