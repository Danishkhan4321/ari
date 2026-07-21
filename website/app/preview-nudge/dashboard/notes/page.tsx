"use client";

import { useState } from "react";
import { DashboardShell, PageHead, Tabs, StatusPill } from "../_shell";

const allNotes = [
  { kind: "Memory", text: "Anniversary on March 15 — book the Italian place she loves",   added: "2 days ago",  pinned: true,  color: "#FFB1D8" },
  { kind: "Note",   text: "Stripe takes 2.9% + $0.30 per txn; Razorpay 2% flat",            added: "5 days ago",  pinned: false, color: "#7BD3F7" },
  { kind: "Contact",text: "Raj — Product Lead at Meridian, met at TechCrunch '25",          added: "1 week ago",  pinned: false, color: "#9BE7BF" },
  { kind: "Memory", text: "Mom's blood group is O+, allergic to penicillin",                added: "2 weeks ago", pinned: true,  color: "#FFB1D8" },
  { kind: "KB",     text: "Onboarding checklist — new teammate (5 steps, ~3 min)",          added: "3 days ago",  pinned: false, color: "#FFE38C" },
  { kind: "KB",     text: "Support SLA: first reply within 24h, escalations flagged same day", added: "1 week ago", pinned: true, color: "#FFE38C" },
  { kind: "Note",   text: "Idea: voice-only mode for driving — auto-detect motion, switch UI", added: "Yesterday", pinned: false, color: "#7BD3F7" },
  { kind: "Note",   text: "Wifi password at office: starlink2024",                            added: "1 month ago", pinned: false, color: "#7BD3F7" },
  { kind: "Memory", text: "Passport X12345, expires Dec 2028. Renewal reminder 6mo prior.", added: "2 months ago",pinned: true,  color: "#FFB1D8" },
  { kind: "Contact",text: "Dr. Iyer — dentist, Indiranagar branch, +91 98xxx xx111",         added: "3 weeks ago", pinned: false, color: "#9BE7BF" },
  { kind: "KB",     text: "Meeting recorder should explain system-audio permission before capture", added: "5 days ago", pinned: false, color: "#FFE38C" },
  { kind: "Note",   text: "Sequoia partner Roelof prefers Tuesday afternoon calls IST",      added: "Yesterday",   pinned: false, color: "#7BD3F7" },
];

const filters = ["all", "Memory", "Note", "KB", "Contact"];

export default function NotesPage() {
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");

  const filtered = allNotes.filter((n) => {
    if (filter !== "all" && n.kind !== filter) return false;
    if (q && !n.text.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  const pinned = filtered.filter((n) => n.pinned);
  const rest = filtered.filter((n) => !n.pinned);

  return (
    <DashboardShell title="notes">
      <PageHead
        title="Notes & KB"
        subtitle="Long-term memory + searchable knowledge base. Save anything once — Ari recalls it forever."
        badge={{ label: "412 saved", color: "#FFE38C" }}
        actions={
          <>
            <button className="dash-btn">Export</button>
            <button className="dash-btn dash-btn-primary">+ New note</button>
          </>
        }
      />

      <div className="flex items-center justify-between flex-wrap gap-3 mb-6">
        <Tabs
          value={filter}
          onChange={setFilter}
          options={filters.map((f) => ({
            value: f,
            label: f === "all" ? "All" : f,
            count:
              f === "all"
                ? allNotes.length
                : allNotes.filter((n) => n.kind === f).length,
          }))}
        />
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search notes…"
          className="dash-input w-[260px]"
        />
      </div>

      {pinned.length > 0 && (
        <>
          <div className="dash-label mb-3">Pinned</div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
            {pinned.map((n, i) => (
              <NoteCard key={i} n={n} />
            ))}
          </div>
        </>
      )}

      <div className="dash-label mb-3">All notes</div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {rest.map((n, i) => (
          <NoteCard key={i} n={n} />
        ))}
      </div>

      {filtered.length === 0 && (
        <p className="text-center text-[13px] text-[#a3a3a3] py-12">
          No notes match — try a different filter or query.
        </p>
      )}
    </DashboardShell>
  );
}

function NoteCard({
  n,
}: {
  n: { kind: string; text: string; added: string; pinned: boolean; color: string };
}) {
  return (
    <article className="dash-card p-4 hover:border-[#0a0a0a] hover:shadow-[3px_3px_0_#0a0a0a] cursor-pointer transition-all relative">
      <span
        className="absolute top-0 left-0 right-0 h-[3px] rounded-t"
        style={{ background: n.color }}
      />
      <div className="flex items-center gap-2 mb-2 mt-1">
        <span className="text-[10px] font-medium text-[#737373] uppercase tracking-wider">
          {n.kind}
        </span>
        <span className="w-1 h-1 rounded-full bg-[#d4d4d4]" />
        <span className="text-[10.5px] text-[#a3a3a3]">{n.added}</span>
        {n.pinned && (
          <span className="ml-auto text-[#F59E0B]" title="Pinned">
            ★
          </span>
        )}
      </div>
      <p className="text-[13px] leading-relaxed text-[#0a0a0a]">{n.text}</p>
    </article>
  );
}
