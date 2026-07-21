"use client";

import { DashboardShell, PageHead, StatusPill } from "../_shell";
import { CrmSubnav } from "./_subnav";

const contacts = [
  { name: "Priya Sharma", title: "Head of Marketing", company: "Meridian Health", email: "priya@meridian.io", phone: "+91 98xxx xx123", stage: "Customer", tag: "VIP", color: "#9BE7BF", last: "2h ago" },
  { name: "Roelof Botha", title: "Partner", company: "Sequoia Capital", email: "roelof@sequoia.com", phone: "+1 415 xxx xxxx", stage: "Negotiation", tag: "Investor", color: "#FFE38C", last: "Yesterday" },
  { name: "Sarah Chen", title: "VP Sales", company: "Acme Corp", email: "sarah@acme.com", phone: "+1 212 xxx xxxx", stage: "Demo done", tag: "Lead", color: "#7BD3F7", last: "Yesterday" },
  { name: "Raj Mehta", title: "Co-founder", company: "Stitch.ai", email: "raj@stitch.ai", phone: "+91 99xxx xx789", stage: "New", tag: "Lead", color: "#FFB1D8", last: "Mon" },
  { name: "Anika Verma", title: "CTO", company: "Lumen Labs", email: "anika@lumenlabs.com", phone: "+91 90xxx xx456", stage: "Customer", tag: "VIP", color: "#9BE7BF", last: "Mon" },
  { name: "James Carter", title: "Sales Head", company: "Northwind", email: "j.carter@nw.com", phone: "+1 646 xxx xxxx", stage: "Cold", tag: "Lead", color: "#FF9D6E", last: "Last week" },
  { name: "Sophie Williams", title: "Freelance Designer", company: "—", email: "sophie@swd.studio", phone: "+44 20 xxx xxxx", stage: "Customer", tag: "Friend", color: "#B7A8FF", last: "Last week" },
  { name: "Ananya Singh", title: "Product Manager", company: "Briolette", email: "ananya@briolette.com", phone: "+91 87xxx xx234", stage: "Demo done", tag: "Lead", color: "#7BD3F7", last: "Last week" },
];

const stageColor: Record<string, string> = {
  New: "#a3a3a3",
  Cold: "#a3a3a3",
  "Demo done": "#7BD3F7",
  Negotiation: "#FFE38C",
  Customer: "#3FAA6E",
};

const stats = [
  { label: "Total contacts", value: 184, accent: "#7BD3F7", hint: "+12 this month" },
  { label: "Active deals", value: 12, accent: "#FFE38C", hint: "$320K pipeline" },
  { label: "Customers", value: 47, accent: "#9BE7BF", hint: "26% conversion" },
  { label: "Touched today", value: 9, accent: "#FFB1D8", hint: "calls + emails" },
];

export default function ContactsPage() {
  return (
    <DashboardShell title="contacts">
      <PageHead
        title="Contacts & CRM"
        subtitle="Track every lead, deal, and customer. Add via chat — Ari auto-fills the rest."
        badge={{ label: "CRM · 184 contacts", color: "#7BD3F7" }}
        actions={
          <>
            <button className="dash-btn">Import CSV</button>
            <button className="dash-btn dash-btn-primary">+ Add contact</button>
          </>
        }
      />

      <CrmSubnav />

      {/* Stats */}
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

      {/* Contact table */}
      <section className="dash-card-hero overflow-hidden">
        <div className="grid grid-cols-[1.5fr,1.2fr,1fr,1fr,90px,90px] bg-[#fbfaf3] border-b border-[#0a0a0a]/15 dash-label px-5">
          <div className="px-1 py-3">Name</div>
          <div className="px-1 py-3">Email</div>
          <div className="px-1 py-3">Stage</div>
          <div className="px-1 py-3">Tag</div>
          <div className="px-1 py-3 text-right">Last</div>
          <div className="px-1 py-3 text-right">Actions</div>
        </div>
        <ul>
          {contacts.map((c, i) => (
            <li
              key={i}
              className={`grid grid-cols-[1.5fr,1.2fr,1fr,1fr,90px,90px] items-center px-5 py-3.5 hover:bg-[#fbfaf3] cursor-pointer group ${
                i !== contacts.length - 1 ? "border-b border-[#efece2]" : ""
              }`}
            >
              <div className="px-1 flex items-center gap-3 min-w-0">
                <div
                  className="w-8 h-8 rounded-full border border-[#0a0a0a] flex items-center justify-center text-[11px] font-bold flex-shrink-0"
                  style={{ background: c.color }}
                >
                  {c.name.split(" ").map((n) => n[0]).slice(0, 2).join("")}
                </div>
                <div className="min-w-0">
                  <div className="text-[13.5px] font-semibold truncate">{c.name}</div>
                  <div className="text-[11.5px] text-[#737373] truncate">
                    {c.title} · {c.company}
                  </div>
                </div>
              </div>
              <div className="px-1 text-[12.5px] text-[#525252] truncate">{c.email}</div>
              <div className="px-1">
                <StatusPill color={stageColor[c.stage] || "#a3a3a3"}>
                  {c.stage}
                </StatusPill>
              </div>
              <div className="px-1">
                <span className="dash-pill">{c.tag}</span>
              </div>
              <div className="px-1 text-right text-[11.5px] text-[#a3a3a3] num">{c.last}</div>
              <div className="px-1 flex justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                <button className="dash-btn !py-1 !px-2.5 !text-[11px]">Open</button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <p className="text-[12px] text-[#a3a3a3] mt-4 text-center">
        Showing 8 of 184 · Add filters via the search bar above
      </p>
    </DashboardShell>
  );
}
