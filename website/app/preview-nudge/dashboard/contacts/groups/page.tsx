"use client";

import { DashboardShell, PageHead, StatusPill } from "../../_shell";
import { CrmSubnav } from "../_subnav";

const groups = [
  { name: "VIP customers", count: 24, color: "#9BE7BF", desc: "High-LTV accounts — touch monthly", lastEmail: "3 days ago" },
  { name: "Investors",      count: 12, color: "#FFE38C", desc: "Quarterly update list",            lastEmail: "12 days ago" },
  { name: "Active leads",   count: 47, color: "#7BD3F7", desc: "In-cycle — weekly nurture",          lastEmail: "5 days ago" },
  { name: "Founders",       count: 31, color: "#FFB1D8", desc: "Personal network — friends",         lastEmail: "Last month" },
  { name: "Cold list Q2",   count: 84, color: "#a3a3a3", desc: "Outbound sequence pending",          lastEmail: "Never" },
  { name: "Demo no-shows",  count: 9,  color: "#FF9D6E", desc: "Re-engagement candidates",           lastEmail: "1 week ago" },
  { name: "Press contacts", count: 18, color: "#B7A8FF", desc: "Tech journalists & analysts",        lastEmail: "2 weeks ago" },
  { name: "Beta testers",   count: 36, color: "#9BE7BF", desc: "Early access cohort",                lastEmail: "Today" },
];

export default function GroupsPage() {
  return (
    <DashboardShell title="contact groups">
      <PageHead
        title="Contact groups"
        subtitle="Slice and dice your contacts into smart segments. Bulk email, schedule, or sync to campaigns."
        badge={{ label: `${groups.length} groups · 261 contacts`, color: "#FFB1D8" }}
        actions={
          <>
            <button className="dash-btn">Import</button>
            <button className="dash-btn dash-btn-primary">+ New group</button>
          </>
        }
      />

      <CrmSubnav />

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {groups.map((g) => (
          <article
            key={g.name}
            className="dash-card p-5 hover:border-[#0a0a0a] hover:shadow-[3px_3px_0_#0a0a0a] cursor-pointer transition-all"
          >
            <div className="flex items-start gap-3">
              <div
                className="w-10 h-10 rounded-md border border-[#0a0a0a] flex items-center justify-center text-[14px] flex-shrink-0"
                style={{ background: g.color }}
              >
                ◉
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-[14px] font-semibold leading-tight">{g.name}</h3>
                <p className="text-[12px] text-[#737373] mt-1 leading-snug line-clamp-2">
                  {g.desc}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-between mt-5 pt-4 border-t border-[#efece2]">
              <span className="text-[12px] text-[#525252]">
                <span className="font-semibold num text-[#0a0a0a]">{g.count}</span> contacts
              </span>
              <span className="text-[11px] text-[#a3a3a3]">Last email · {g.lastEmail}</span>
            </div>
          </article>
        ))}
      </div>
    </DashboardShell>
  );
}
