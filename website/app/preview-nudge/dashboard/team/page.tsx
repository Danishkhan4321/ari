"use client";

import { DashboardShell, PageHead, StatusPill } from "../_shell";

const members = [
  { name: "Danish Khan",       role: "Owner",     email: "danish@ari.local",   status: "Active",   lastSeen: "Now",         color: "#FF9D6E", initials: "DK" },
  { name: "Priya Sharma",      role: "Admin",     email: "priya@ari.local",    status: "Active",   lastSeen: "10m ago",     color: "#9BE7BF", initials: "PS" },
  { name: "Raj Mehta",         role: "Member",    email: "raj@ari.local",      status: "Active",   lastSeen: "2h ago",      color: "#7BD3F7", initials: "RM" },
  { name: "Anika Verma",       role: "Member",    email: "anika@ari.local",    status: "Active",   lastSeen: "Yesterday",   color: "#FFE38C", initials: "AV" },
  { name: "Maya Patel",        role: "Viewer",    email: "maya@ari.local",     status: "Active",   lastSeen: "Last week",   color: "#FFB1D8", initials: "MP" },
  { name: "Tom Blake",         role: "Member",    email: "tom@ari.local",      status: "Invited",  lastSeen: "—",            color: "#B7A8FF", initials: "TB" },
];

const standups = [
  { name: "Engineering",   members: 4, time: "Daily 10:00 AM",   last: "Today, 10:30 AM", color: "#7BD3F7" },
  { name: "Marketing",     members: 3, time: "Daily 11:00 AM",   last: "Today, 11:18 AM", color: "#FFB1D8" },
  { name: "Founders sync", members: 2, time: "Mon/Wed/Fri 9 AM", last: "Yesterday",        color: "#FFE38C" },
];

const stats = [
  { label: "Members",          value: 6,    accent: "#7BD3F7", hint: "active this week" },
  { label: "Active standups",  value: 3,    accent: "#FFE38C", hint: "auto-collected" },
  { label: "Tasks assigned",   value: 24,   accent: "#9BE7BF", hint: "across team" },
  { label: "Avg response",     value: "8m", accent: "#FFB1D8", hint: "to Ari DMs" },
];

export default function TeamPage() {
  return (
    <DashboardShell title="team">
      <PageHead
        title="Team"
        subtitle="Members, roles, automated standups, and shared tasks. Ari DMs each member at scheduled times."
        badge={{ label: "Team · 6 members", color: "#7BD3F7" }}
        actions={
          <>
            <button className="dash-btn">Roles</button>
            <button className="dash-btn dash-btn-primary">+ Invite</button>
          </>
        }
      />

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
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
        {/* Members — hero */}
        <section className="dash-card-hero overflow-hidden">
          <div className="px-6 py-5 border-b border-[#0a0a0a]/15 flex items-center justify-between">
            <h2 className="dash-h2">Members</h2>
            <span className="text-[11px] text-[#737373]">6 of 8 seats used</span>
          </div>
          <ul>
            {members.map((m, i) => (
              <li
                key={i}
                className={`flex items-center gap-4 px-6 py-4 hover:bg-[#fbfaf3] cursor-pointer group ${
                  i !== members.length - 1 ? "border-b border-[#efece2]" : ""
                }`}
              >
                <div
                  className="w-9 h-9 rounded-full border border-[#0a0a0a] flex items-center justify-center text-[12px] font-bold flex-shrink-0"
                  style={{ background: m.color }}
                >
                  {m.initials}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[13.5px] font-semibold truncate">{m.name}</div>
                  <div className="text-[11.5px] text-[#737373] truncate">{m.email}</div>
                </div>
                <span className="dash-pill">{m.role}</span>
                <StatusPill color={m.status === "Active" ? "#3FAA6E" : "#a3a3a3"}>
                  {m.status}
                </StatusPill>
                <span className="text-[11px] text-[#a3a3a3] w-20 text-right hidden md:block num">
                  {m.lastSeen}
                </span>
                <button className="dash-btn !py-1 !px-2.5 !text-[11px] opacity-0 group-hover:opacity-100 transition-opacity">
                  ⋯
                </button>
              </li>
            ))}
          </ul>
        </section>

        {/* Standups */}
        <section className="dash-card overflow-hidden">
          <div className="px-5 py-4 border-b border-[#e8e6dc] flex items-center justify-between">
            <h3 className="dash-h2">Automated standups</h3>
            <button className="text-[12px] text-[#737373] hover:text-[#0a0a0a]">+ Add</button>
          </div>
          <ul>
            {standups.map((s, i) => (
              <li
                key={i}
                className={`flex items-start gap-4 px-5 py-4 hover:bg-[#fbfaf3] cursor-pointer ${
                  i !== standups.length - 1 ? "border-b border-[#efece2]" : ""
                }`}
              >
                <div
                  className="w-9 h-9 rounded-md border border-[#0a0a0a] flex items-center justify-center text-[14px] flex-shrink-0"
                  style={{ background: s.color }}
                >
                  ◉
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-semibold truncate">{s.name}</div>
                  <div className="text-[11.5px] text-[#737373] mt-0.5 num">{s.time}</div>
                  <div className="text-[10.5px] text-[#a3a3a3] mt-1">
                    Last collected · {s.last}
                  </div>
                </div>
                <span className="text-[11px] text-[#737373] num flex-shrink-0">
                  {s.members}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </DashboardShell>
  );
}
