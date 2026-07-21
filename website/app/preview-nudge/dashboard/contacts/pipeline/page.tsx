"use client";

import { DashboardShell, PageHead, StatusPill } from "../../_shell";
import { CrmSubnav } from "../_subnav";

const stages = [
  { id: "new",  label: "New",          accent: "#a3a3a3", value: "$45K" },
  { id: "qual", label: "Qualified",    accent: "#7BD3F7", value: "$92K" },
  { id: "demo", label: "Demo done",    accent: "#FFE38C", value: "$138K" },
  { id: "neg",  label: "Negotiation",  accent: "#FFB1D8", value: "$200K" },
  { id: "won",  label: "Won",          accent: "#9BE7BF", value: "$320K MTD" },
] as const;

const deals: Record<string, { name: string; company: string; value: string; days: number; owner: string }[]> = {
  new:  [
    { name: "Raj Mehta",        company: "Stitch.ai",     value: "$15K", days: 1,  owner: "AT" },
    { name: "James Carter",     company: "Northwind",     value: "$30K", days: 4,  owner: "AT" },
  ],
  qual: [
    { name: "Maya Patel",       company: "Linea",         value: "$24K", days: 6,  owner: "PR" },
    { name: "Ben Park",         company: "Vela Studio",   value: "$28K", days: 8,  owner: "AT" },
    { name: "Nadia Khan",       company: "Indie Goods",   value: "$40K", days: 11, owner: "PR" },
  ],
  demo: [
    { name: "Sarah Chen",       company: "Acme Corp",     value: "$60K", days: 3,  owner: "AT" },
    { name: "Ananya Singh",     company: "Briolette",     value: "$48K", days: 5,  owner: "AT" },
    { name: "Tom Blake",        company: "Northpath",     value: "$30K", days: 9,  owner: "PR" },
  ],
  neg: [
    { name: "Roelof Botha",     company: "Sequoia",       value: "$120K", days: 2, owner: "AT" },
    { name: "Mira Holm",        company: "Nudge Folio",   value: "$80K", days: 7,  owner: "AT" },
  ],
  won: [
    { name: "Priya Sharma",     company: "Meridian",      value: "$180K", days: 0, owner: "AT" },
    { name: "Anika Verma",      company: "Lumen Labs",    value: "$140K", days: 3, owner: "AT" },
  ],
};

export default function PipelinePage() {
  const stats = [
    { label: "Pipeline value",    value: "$320K", accent: "#FFE38C", hint: "across 12 deals" },
    { label: "Won this month",    value: "$320K", accent: "#9BE7BF", hint: "+18% MoM" },
    { label: "Avg days to close", value: "21",    accent: "#7BD3F7", hint: "-4 vs last quarter" },
    { label: "Conversion",        value: "26%",   accent: "#FFB1D8", hint: "Demo → Won" },
  ];

  return (
    <DashboardShell title="pipeline">
      <PageHead
        title="Sales pipeline"
        subtitle="Drag deals between stages. Ari auto-tracks emails, meetings, and follow-ups for each."
        badge={{ label: "Pipeline · 12 active deals", color: "#FFE38C" }}
        actions={
          <>
            <button className="dash-btn">Forecast</button>
            <button className="dash-btn dash-btn-primary">+ Add deal</button>
          </>
        }
      />

      <CrmSubnav />

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

      {/* Kanban */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
        {stages.map((stage) => (
          <div key={stage.id} className="dash-card overflow-hidden flex flex-col">
            <div className="px-4 py-3 border-b border-[#e8e6dc]">
              <div className="flex items-center gap-2 mb-1">
                <span className="w-2 h-2 rounded-full" style={{ background: stage.accent }} />
                <span className="text-[12.5px] font-semibold flex-1">{stage.label}</span>
                <span className="text-[11px] text-[#a3a3a3] num">{deals[stage.id].length}</span>
              </div>
              <div className="text-[11px] text-[#737373] num">{stage.value}</div>
            </div>
            <div className="p-3 space-y-2 flex-1 min-h-[140px]">
              {deals[stage.id].map((d, i) => (
                <article
                  key={i}
                  className="bg-white border border-[#e8e6dc] rounded-lg p-3 hover:border-[#0a0a0a] hover:shadow-[2px_2px_0_#0a0a0a] cursor-grab active:cursor-grabbing transition-all"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold truncate">{d.name}</div>
                      <div className="text-[11px] text-[#737373] truncate">{d.company}</div>
                    </div>
                    <div className="text-[12px] num font-medium text-[#0a0a0a] flex-shrink-0">
                      {d.value}
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-3">
                    <span className="text-[10.5px] text-[#a3a3a3] num">{d.days}d in stage</span>
                    <div className="w-5 h-5 rounded-full bg-[#0a0a0a] text-white flex items-center justify-center text-[9px] font-bold">
                      {d.owner}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </div>
        ))}
      </div>
    </DashboardShell>
  );
}
