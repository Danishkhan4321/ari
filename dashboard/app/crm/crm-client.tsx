"use client";
// dashboard/app/crm/crm-client.tsx
// Interactive pipeline board + contacts list. Two tabs:
//   - Pipeline: leads grouped into stage columns. Each card has a stage
//     dropdown that PATCHes /api/crm/leads and optimistically re-buckets.
//   - Contacts: read-only address-book table (write-back is a later phase).
import { useState } from "react";
// Import from the CLIENT-SAFE module — NOT @/lib/crm, which imports pg
// (Postgres) via ./db and would pull Node built-ins (fs/dns/net/tls) into
// the browser bundle and break the build.
import {
  STAGES,
  STAGE_LABELS,
  STAGE_COLORS,
  normalizeStage,
  type Lead,
  type Contact,
  type Stage,
} from "@/lib/crm-shared";

export default function CrmClient({
  initialLeads,
  contacts,
}: {
  initialLeads: Lead[];
  contacts: Contact[];
}) {
  const [tab, setTab] = useState<"pipeline" | "contacts">("pipeline");
  const [leads, setLeads] = useState<Lead[]>(initialLeads);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function moveLead(leadId: number, stage: Stage) {
    setBusyId(leadId);
    setError(null);
    // Optimistic update
    const prev = leads;
    setLeads((ls) => ls.map((l) => (l.id === leadId ? { ...l, stage } : l)));
    try {
      const res = await fetch("/api/crm/leads", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leadId, stage }),
      });
      if (!res.ok) {
        // Roll back on failure
        setLeads(prev);
        const body = await res.json().catch(() => ({}));
        setError(body?.error || `Move failed (${res.status})`);
      }
    } catch (e) {
      setLeads(prev);
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusyId(null);
    }
  }

  const byStage = (s: Stage) => leads.filter((l) => normalizeStage(l.stage) === s);

  return (
    <div>
      {/* Tabs */}
      <div className="flex gap-2 mb-5">
        <button
          onClick={() => setTab("pipeline")}
          className={`btn-brutal-sm ${tab === "pipeline" ? "bg-card-purple" : "bg-card"}`}
        >
          Pipeline
        </button>
        <button
          onClick={() => setTab("contacts")}
          className={`btn-brutal-sm ${tab === "contacts" ? "bg-card-purple" : "bg-card"}`}
        >
          Contacts ({contacts.length})
        </button>
      </div>

      {error && (
        <div className="card-brutal rounded-[4px] p-3 mb-4 bg-card-orange text-sm">
          {error}
        </div>
      )}

      {tab === "pipeline" ? (
        leads.length === 0 ? (
          <EmptyState
            title="No leads yet"
            body='Add one from WhatsApp: "new lead John from Acme, john@acme.com, interested in premium plan"'
          />
        ) : (
          <div className="flex gap-4 overflow-x-auto pb-4">
            {STAGES.map((stage) => {
              const items = byStage(stage);
              return (
                <div key={stage} className="min-w-[260px] w-[260px] flex-shrink-0">
                  <div className={`card-brutal rounded-[4px] px-3 py-2 mb-3 ${STAGE_COLORS[stage]}`}>
                    <div className="font-bold text-sm flex items-center justify-between">
                      <span>{STAGE_LABELS[stage]}</span>
                      <span className="font-mono">{items.length}</span>
                    </div>
                  </div>
                  <div className="space-y-3">
                    {items.map((lead) => (
                      <LeadCard
                        key={lead.id}
                        lead={lead}
                        busy={busyId === lead.id}
                        onMove={(s) => moveLead(lead.id, s)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : (
        <ContactsTable contacts={contacts} />
      )}
    </div>
  );
}

function LeadCard({
  lead,
  busy,
  onMove,
}: {
  lead: Lead;
  busy: boolean;
  onMove: (stage: Stage) => void;
}) {
  return (
    <div className={`card-brutal rounded-[4px] p-3 ${busy ? "opacity-50" : ""}`}>
      <div className="font-semibold">{lead.name}</div>
      {lead.company && <div className="text-sm text-txt-muted">{lead.company}</div>}
      {lead.email && (
        <div className="text-xs font-mono mt-1 break-all">{lead.email}</div>
      )}
      {lead.deal_value && Number(lead.deal_value) > 0 && (
        <div className="text-sm font-bold mt-1">₹{Number(lead.deal_value).toLocaleString("en-IN")}</div>
      )}
      {lead.last_contacted_at && (
        <div className="text-[11px] text-txt-muted mt-1">
          Last: {new Date(lead.last_contacted_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
        </div>
      )}
      <select
        value={normalizeStage(lead.stage)}
        disabled={busy}
        onChange={(e) => onMove(e.target.value as Stage)}
        className="mt-2 w-full text-xs border-2 border-black rounded-[3px] px-2 py-1 bg-white font-semibold cursor-pointer"
      >
        {STAGES.map((s) => (
          <option key={s} value={s}>
            {STAGE_LABELS[s]}
          </option>
        ))}
      </select>
    </div>
  );
}

function ContactsTable({ contacts }: { contacts: Contact[] }) {
  if (contacts.length === 0) {
    return (
      <EmptyState
        title="No contacts yet"
        body='Save one from WhatsApp: "Save John&apos;s number: +91XXXXXXXXXX"'
      />
    );
  }
  return (
    <div className="card-brutal rounded-[4px] overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-card-lemon border-b-2 border-black">
          <tr>
            <th className="text-left px-4 py-2 font-bold">Name</th>
            <th className="text-left px-4 py-2 font-bold">Phone</th>
            <th className="text-left px-4 py-2 font-bold hidden md:table-cell">Category</th>
            <th className="text-left px-4 py-2 font-bold hidden md:table-cell">Notes</th>
          </tr>
        </thead>
        <tbody>
          {contacts.map((c, i) => (
            <tr key={c.id} className={i % 2 ? "bg-white" : "bg-[#fafafa]"}>
              <td className="px-4 py-2 font-semibold">{c.name}</td>
              <td className="px-4 py-2 font-mono">{c.phone}</td>
              <td className="px-4 py-2 hidden md:table-cell text-txt-muted">{c.category || "general"}</td>
              <td className="px-4 py-2 hidden md:table-cell text-txt-muted truncate max-w-[300px]">{c.notes || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="card-brutal rounded-[4px] p-8 text-center">
      <div className="text-xl font-bold mb-2">{title}</div>
      <p className="text-txt-muted text-sm">{body}</p>
    </div>
  );
}
