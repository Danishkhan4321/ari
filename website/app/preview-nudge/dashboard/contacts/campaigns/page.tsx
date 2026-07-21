"use client";

import { DashboardShell, PageHead, StatusPill } from "../../_shell";
import { CrmSubnav } from "../_subnav";

const campaigns = [
  {
    name: "Q3 launch announcement",
    status: "Live",
    statusColor: "#3FAA6E",
    audience: "Active leads + Beta testers",
    sent: 247,
    open: 68,
    click: 23,
    reply: 11,
    sentAt: "2h ago",
  },
  {
    name: "Product update — Meeting recorder v2",
    status: "Scheduled",
    statusColor: "#FFE38C",
    audience: "VIP customers",
    sent: 0,
    open: 0,
    click: 0,
    reply: 0,
    sentAt: "Tomorrow 9 AM",
  },
  {
    name: "Cold outbound — Founders, India",
    status: "Draft",
    statusColor: "#a3a3a3",
    audience: "Cold list Q2",
    sent: 0,
    open: 0,
    click: 0,
    reply: 0,
    sentAt: "—",
  },
  {
    name: "Investor update — March",
    status: "Sent",
    statusColor: "#7BD3F7",
    audience: "Investors",
    sent: 12,
    open: 100,
    click: 75,
    reply: 42,
    sentAt: "12 days ago",
  },
  {
    name: "Re-engage demo no-shows",
    status: "Live",
    statusColor: "#3FAA6E",
    audience: "Demo no-shows",
    sent: 9,
    open: 56,
    click: 22,
    reply: 33,
    sentAt: "Yesterday",
  },
];

export default function CampaignsPage() {
  return (
    <DashboardShell title="campaigns">
      <PageHead
        title="Email campaigns"
        subtitle="Draft, schedule, and ship sequences. Ari writes, you approve, the bot sends — all from chat or here."
        badge={{ label: "Campaigns · 5 total · 2 live", color: "#9BE7BF" }}
        actions={
          <>
            <button className="dash-btn">Templates</button>
            <button className="dash-btn dash-btn-primary">+ New campaign</button>
          </>
        }
      />

      <CrmSubnav />

      <section className="dash-card-hero overflow-hidden">
        <div className="grid grid-cols-[1.6fr,1.2fr,90px,90px,90px,90px,110px] bg-[#fbfaf3] border-b border-[#0a0a0a]/15 dash-label px-5">
          <div className="px-1 py-3">Campaign</div>
          <div className="px-1 py-3">Audience</div>
          <div className="px-1 py-3 text-right">Sent</div>
          <div className="px-1 py-3 text-right">Open %</div>
          <div className="px-1 py-3 text-right">Click %</div>
          <div className="px-1 py-3 text-right">Reply %</div>
          <div className="px-1 py-3 text-right">Status</div>
        </div>
        <ul>
          {campaigns.map((c, i) => (
            <li
              key={i}
              className={`grid grid-cols-[1.6fr,1.2fr,90px,90px,90px,90px,110px] items-center px-5 py-4 hover:bg-[#fbfaf3] cursor-pointer ${
                i !== campaigns.length - 1 ? "border-b border-[#efece2]" : ""
              }`}
            >
              <div className="px-1 min-w-0">
                <div className="text-[13.5px] font-semibold truncate">{c.name}</div>
                <div className="text-[11px] text-[#a3a3a3] mt-0.5">{c.sentAt}</div>
              </div>
              <div className="px-1 text-[12.5px] text-[#525252] truncate">{c.audience}</div>
              <div className="px-1 text-right num text-[12.5px] font-medium">
                {c.sent || "—"}
              </div>
              <div className="px-1 text-right num text-[12.5px]">
                <RateCell n={c.open} />
              </div>
              <div className="px-1 text-right num text-[12.5px]">
                <RateCell n={c.click} />
              </div>
              <div className="px-1 text-right num text-[12.5px]">
                <RateCell n={c.reply} />
              </div>
              <div className="px-1 flex justify-end">
                <StatusPill color={c.statusColor}>{c.status}</StatusPill>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </DashboardShell>
  );
}

function RateCell({ n }: { n: number }) {
  if (n === 0) return <span className="text-[#a3a3a3]">—</span>;
  return (
    <span
      className={
        n >= 50
          ? "text-[#3FAA6E] font-medium"
          : n >= 20
          ? "text-[#0a0a0a] font-medium"
          : "text-[#737373]"
      }
    >
      {n}%
    </span>
  );
}
