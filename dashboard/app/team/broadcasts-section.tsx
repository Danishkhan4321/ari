"use client";

// Broadcasts — admin-only composer that sends a WhatsApp message to
// every team member, plus history of past broadcasts with delivered/
// read counts. The demo moment: managers send once, see who actually
// read it on the dashboard.
import { useEffect, useState } from "react";
import { EmptyState } from "@/components/dash-page";
import { trackSync } from "@/lib/analytics";
import { readJsonResponse } from "@/lib/http";

type Broadcast = {
  id: number; admin_phone: string; team_name: string | null;
  message_text: string; message_type: string;
  total_members: number; created_at: string;
  delivered_count: number; read_count: number; failed_count: number;
};

type Recipient = {
  id: number; team_message_id: number;
  member_phone: string; member_name: string | null;
  wamid: string | null; status: string; status_updated_at: string | null; created_at: string;
};

export function BroadcastsSection({ teamName, isAdmin }: { teamName: string; isAdmin: boolean }) {
  const [broadcasts, setBroadcasts] = useState<Broadcast[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [recipients, setRecipients] = useState<Record<number, Recipient[]>>({});
  const [composer, setComposer] = useState("");
  const [busy, setBusy] = useState(false);
  const [sendResult, setSendResult] = useState<string | null>(null);

  async function refresh() {
    try {
      const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/broadcasts`, { cache: "no-store" });
      const d = await readJsonResponse<{ ok?: boolean; broadcasts?: Broadcast[]; error?: string }>(r);
      if (r.ok && d?.ok && d.broadcasts) setBroadcasts(d.broadcasts);
      else setError(d?.error || "Could not load broadcasts.");
    } catch {
      setError("Could not load broadcasts.");
    }
  }
  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [teamName]);

  async function loadRecipients(id: number) {
    if (recipients[id]) return; // cached
    try {
      const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/broadcasts/${id}`, { cache: "no-store" });
      const d = await readJsonResponse<{ ok?: boolean; recipients?: Recipient[] }>(r);
      if (r.ok && d?.ok && d.recipients) setRecipients(rs => ({ ...rs, [id]: d.recipients! }));
    } catch { /* swallow */ }
  }

  async function send() {
    if (!composer.trim()) return;
    if (!confirm(`Send this announcement to all ${broadcasts ? "members of " + teamName : "team members"}?`)) return;
    setBusy(true); setSendResult(null);
    try {
      const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/broadcasts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: composer.trim() }),
      });
      const payload = await readJsonResponse<{
        ok?: boolean;
        sent?: number;
        failed?: number;
        error?: string;
        failed_recipients?: { name: string; phone: string }[];
      }>(r);
      const d = {
        ok: payload?.ok === true,
        sent: payload?.sent ?? 0,
        failed: payload?.failed ?? 0,
        error: payload?.error || "The broadcast service returned an invalid response.",
        failed_recipients: payload?.failed_recipients ?? [],
      };
      if (!d.ok) { setSendResult(`⚠️ ${d.error}`); return; }
      setSendResult(`✓ Sent — ${d.sent} delivered${d.failed > 0 ? `, ${d.failed} failed` : ""}`);
      // Activation event — server tells us how many delivered
      if (d.failed > 0) {
        const names = d.failed_recipients.map(item => item.name).filter(Boolean).slice(0, 4);
        setSendResult(`Sent to ${d.sent}; ${d.failed} failed${names.length ? ` (${names.join(", ")})` : ""}.`);
      }
      trackSync("first_broadcast_sent", {
        team: teamName,
        sent: d.sent,
        failed: d.failed,
        is_first: (broadcasts?.length ?? 0) === 0,
      });
      setComposer("");
      void refresh();
    } catch (e) {
      setSendResult(`⚠️ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  if (broadcasts === null) return <div className="dash-card p-10 text-center text-[13px] text-[#a3a3a3]">Loading broadcasts…</div>;

  return (
    <div className="space-y-5">
      {error && (
        <div className="dash-card bg-[#FFB1D8]/30 border border-[#FFB1D8] px-4 py-3 text-sm">
          ⚠️ {error} <button onClick={() => setError(null)} className="ml-2">×</button>
        </div>
      )}

      {/* Composer */}
      {isAdmin && (
        <section className="dash-card-hero p-5">
          <div className="dash-label mb-2 flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[#D8CCFF]" />
            New announcement
          </div>
          <textarea
            value={composer}
            onChange={(e) => setComposer(e.target.value)}
            rows={4}
            placeholder={`Hey ${teamName}, all-hands moved to 4pm tomorrow. Bring laptops.`}
            className="dash-input w-full resize-none mt-1 leading-relaxed"
          />
          <div className="flex items-center justify-between mt-3 flex-wrap gap-2">
            <div className="text-[11.5px] text-[#737373]">
              Sent as a regular WhatsApp text to each team member. You&apos;ll see delivered &amp; read counts below.
            </div>
            <div className="flex items-center gap-3">
              {sendResult && (
                <span className={`text-[12px] ${sendResult.startsWith("✓") ? "text-[#3FAA6E]" : "text-[#ef4444]"}`}>
                  {sendResult}
                </span>
              )}
              <button
                onClick={send}
                disabled={busy || !composer.trim()}
                className="dash-btn dash-btn-primary disabled:opacity-40"
              >
                {busy ? "Sending…" : "Send broadcast"}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* History */}
      <section className="dash-card overflow-hidden">
        <div className="px-5 py-4 border-b border-[#E8E3ED] flex items-center justify-between">
          <h3 className="dash-h2 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#8A65FF]" />
            Past broadcasts
          </h3>
          <span className="text-[11px] text-[#737373]">{broadcasts.length} total</span>
        </div>

        {broadcasts.length === 0 ? (
          <EmptyState
            icon="📣"
            title="No broadcasts yet"
            body={
              isAdmin
                ? "Send your first announcement above. Every team member gets a WhatsApp; you'll see who read it here."
                : "Admins can send team-wide announcements from this tab. They'll appear in your WhatsApp."
            }
            cta={isAdmin ? (
              <button
                onClick={() => {
                  setComposer("Hey team — quick update for the week:\n\n");
                  document.querySelector<HTMLTextAreaElement>('textarea')?.focus();
                }}
                className="dash-btn dash-btn-primary"
              >
                Start with a template
              </button>
            ) : undefined}
          />
        ) : (
          <ul>
            {broadcasts.map((b, i, arr) => {
              const expanded = openId === b.id;
              const recs = recipients[b.id];
              const sentRatio = b.total_members > 0
                ? `${b.delivered_count}/${b.total_members}`
                : `${b.delivered_count}`;
              const readPct = b.total_members > 0 ? Math.round((b.read_count / b.total_members) * 100) : 0;
              return (
                <li key={b.id} className={i !== arr.length - 1 ? "border-b border-[#E8E3ED]" : ""}>
                  <button
                    onClick={() => {
                      setOpenId(expanded ? null : b.id);
                      if (!expanded) void loadRecipients(b.id);
                    }}
                    className="w-full text-left px-5 py-4 hover:bg-[#FBFAFE] transition-colors"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-[13.5px] leading-relaxed break-words whitespace-pre-wrap">
                          {b.message_text.length > 220 && !expanded
                            ? b.message_text.slice(0, 220) + "…"
                            : b.message_text}
                        </div>
                        <div className="text-[11.5px] text-[#a3a3a3] mt-2 flex items-center gap-3 flex-wrap">
                          <span>{fmtAgo(b.created_at)}</span>
                          <span className="num text-[#737373]">📩 {sentRatio} delivered</span>
                          <span className="num text-[#737373]">👁️ {b.read_count} read · {readPct}%</span>
                          {b.failed_count > 0 && <span className="text-[#ef4444]">⚠️ {b.failed_count} failed</span>}
                        </div>
                      </div>
                      <svg className={`flex-shrink-0 mt-1 transition-transform ${expanded ? "rotate-180" : ""}`} width="14" height="14" viewBox="0 0 16 16" fill="none">
                        <path d="M5 6.5l3 3 3-3" stroke="#737373" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                  </button>
                  {expanded && (
                    <div className="bg-[#FBFAFE]/50 border-t border-[#E8E3ED] px-5 py-3">
                      {!recs ? (
                        <div className="text-[12px] text-[#a3a3a3]">Loading…</div>
                      ) : recs.length === 0 ? (
                        <div className="text-[12px] text-[#a3a3a3]">No recipients recorded.</div>
                      ) : (
                        <ul className="text-[12.5px] grid sm:grid-cols-2 gap-x-4 gap-y-1.5">
                          {recs.map(r => (
                            <li key={r.id} className="flex items-center gap-2">
                              <StatusDot status={r.status} />
                              <span className="flex-1 truncate">{r.member_name || `+${r.member_phone}`}</span>
                              <span className="text-[10.5px] text-[#a3a3a3]">{r.status}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color = status === "read"      ? "#3FAA6E"
              : status === "delivered" ? "#8A65FF"
              : status === "sent"      ? "#D8CCFF"
              : status === "failed"    ? "#ef4444"
              : "#a3a3a3";
  return <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />;
}

function fmtAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return `${months}mo ago`;
}
