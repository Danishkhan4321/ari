"use client";

// Inbox — demo-styled scheduled-email list. Pending live in dash-card-hero
// with a hover-revealed Cancel; sent/cancelled history collapses below.
import { useEffect, useState } from "react";
import { StatusPill, EmptyState } from "@/components/dash-page";

type Email = {
  id: number; recipients: string[] | string; subject: string;
  status: string; lead_id: number | null; email_type: string | null;
  is_recurring: boolean; recurrence_pattern: string | null; recurrence_days: string | null;
};

export function InboxContent() {
  const [emails, setEmails] = useState<Email[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  async function refresh() {
    try {
      const res = await fetch("/api/inbox/scheduled", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as { emails?: Email[]; error?: string };
      if (d.emails) { setEmails(d.emails); setError(null); }
      else setError(d.error || "Could not load.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => { void refresh(); }, []);

  async function cancel(id: number) {
    setBusy(id);
    try {
      const res = await fetch("/api/inbox/scheduled", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action: "cancel" }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setError(d.error || "Could not cancel.");
      } else { await refresh(); }
    } finally { setBusy(null); }
  }

  if (emails === null) {
    return (
      <div className="dash-card p-10 text-center text-[13px] text-[#a3a3a3]">
        {error ? `⚠️ ${error}` : "Loading…"}
      </div>
    );
  }
  const pending = emails.filter(e => ["pending","queued","scheduled"].includes(e.status));
  const past = emails.filter(e => !["pending","queued","scheduled"].includes(e.status));

  return (
    <div className="space-y-6">
      {error && (
        <div className="dash-card bg-[#FFB1D8]/30 border border-[#FFB1D8] px-4 py-3 text-sm">⚠️ {error}</div>
      )}

      {pending.length === 0 ? (
        <EmptyState
          icon="📤"
          title="Nothing waiting"
          body="Scheduled emails will appear here. Schedule one from the bulk-email composer in any group."
        />
      ) : (
        <section className="dash-card-hero overflow-hidden">
          <div className="px-6 py-4 border-b border-[#0a0a0a]/15 flex items-center justify-between">
            <h2 className="dash-h2">
              Pending <span className="text-[#a3a3a3] font-normal num">({pending.length})</span>
            </h2>
          </div>
          <ul>
            {pending.map((e, i) => (
              <li
                key={e.id}
                className={`flex items-center gap-4 px-6 py-4 hover:bg-[#FBFAFE] transition-colors group ${
                  i !== pending.length - 1 ? "border-b border-[#E8E3ED]" : ""
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-[#FFB1D8] flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[13.5px] font-medium text-[#0a0a0a] break-words">
                    {e.subject || <span className="text-[#a3a3a3] font-normal">(no subject)</span>}
                  </div>
                  <div className="text-[11.5px] text-[#737373] mt-1 break-all truncate">
                    → {Array.isArray(e.recipients) ? e.recipients.join(", ") : String(e.recipients || "")}
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {e.email_type && <StatusPill color="#8A65FF">{e.email_type}</StatusPill>}
                    {e.is_recurring && <StatusPill color="#D8CCFF">{[e.recurrence_pattern, e.recurrence_days].filter(Boolean).join(" ") || "recurring"}</StatusPill>}
                  </div>
                </div>
                <button
                  disabled={busy === e.id}
                  onClick={() => cancel(e.id)}
                  className="opacity-0 group-hover:opacity-100 dash-btn !py-1 !px-2.5 !text-[11px] flex-shrink-0 transition-opacity disabled:opacity-50"
                >
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {past.length > 0 && (
        <details className="dash-card overflow-hidden">
          <summary className="cursor-pointer px-5 py-4 border-b border-[#E8E3ED] flex items-center justify-between">
            <span className="dash-h2">History ({past.length})</span>
            <span className="text-[11px] text-[#a3a3a3]">click to expand</span>
          </summary>
          <ul>
            {past.slice(0, 50).map((e, i) => (
              <li
                key={e.id}
                className={`px-5 py-3 text-[13px] flex items-center justify-between gap-3 ${
                  i !== Math.min(past.length, 50) - 1 ? "border-b border-[#E8E3ED]" : ""
                }`}
              >
                <span className="truncate">
                  <span className="text-[10px] uppercase font-bold mr-2 text-[#a3a3a3] tracking-wider">{e.status}</span>
                  {e.subject}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
