"use client";

// Settings — combined admin tab covering: per-member metadata
// (birthday / anniversary / manager), 1:1 schedule, new-hire
// onboarding tracker, public team page settings, and the
// WhatsApp invite link.
import { useEffect, useState } from "react";

type Member = { member_phone: string; member_name: string | null };
type Meta = { member_phone: string; birthday: string | null; joined_at: string | null; manager_phone: string | null; notes: string | null };
type OneOnOne = {
  id: number; manager_phone: string; manager_name: string | null;
  report_phone: string; report_name: string | null;
  next_at: string; cadence_days: number | null; agenda: string | null;
};
type Onboarding = {
  id: number; member_phone: string; member_name: string | null;
  started_at: string; completed_at: string | null; last_nudge_idx: number;
};

export function SettingsSection({
  teamName, isAdmin, members,
}: {
  teamName: string; isAdmin: boolean; members: Member[];
}) {
  if (!isAdmin) {
    return (
      <div className="dash-card p-10 text-center">
        <div className="dash-label mb-2">Admin only</div>
        <div className="text-[13.5px] text-[#737373]">
          Team settings (member dates, 1:1s, public page, invite link) are admin-only.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <InvitePanel teamName={teamName} />
      <MetaPanel teamName={teamName} members={members} />
      <OneOnOnesPanel teamName={teamName} members={members} />
      <OnboardingPanel teamName={teamName} members={members} />
      <PublicPagePanel teamName={teamName} />
    </div>
  );
}

// ─── Invite link ────────────────────────────────────────────────────────

function InvitePanel({ teamName }: { teamName: string }) {
  const [link, setLink] = useState<{ whatsapp_url: string; prefill_text: string; ari_number: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function load() {
    setBusy(true);
    try {
      const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/invite-link`, { cache: "no-store" });
      const d = await r.json();
      if (d.ok) setLink(d);
    } finally { setBusy(false); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [teamName]);

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.whatsapp_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* swallow */ }
  }

  return (
    <section className="dash-card-hero p-5">
      <div className="dash-label mb-2 flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-[#D8CCFF]" />
        Share invite link
      </div>
      <h3 className="dash-h2 mb-1">One-tap WhatsApp join</h3>
      <p className="text-[12.5px] text-[#737373] mb-3 leading-relaxed">
        Anyone who taps this link gets WhatsApp prefilled with the join message.
        Send Ari that text and they&apos;re added to {teamName}.
      </p>
      {!link ? (
        <div className="text-[12px] text-[#a3a3a3]">{busy ? "Generating…" : "—"}</div>
      ) : (
        <div className="flex items-center gap-2 bg-white border border-[#E8E3ED] rounded-md px-3 py-2 max-w-full">
          <span className="font-mono text-[12px] truncate flex-1">{link.whatsapp_url}</span>
          <button onClick={copy} className="dash-btn !text-[11px]">{copied ? "Copied!" : "Copy"}</button>
          <a href={link.whatsapp_url} target="_blank" rel="noreferrer" className="dash-btn !text-[11px]">Open</a>
        </div>
      )}
    </section>
  );
}

// ─── Member meta editor ─────────────────────────────────────────────────

function MetaPanel({ teamName, members }: { teamName: string; members: Member[] }) {
  const [meta, setMeta] = useState<Meta[]>([]);
  const [busyPhone, setBusyPhone] = useState<string | null>(null);

  async function refresh() {
    try {
      const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/meta`, { cache: "no-store" });
      const d = await r.json();
      if (d.ok) setMeta(d.meta);
    } catch { /* swallow */ }
  }
  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [teamName]);

  async function save(memberPhone: string, patch: Partial<Meta>) {
    setBusyPhone(memberPhone);
    try {
      await fetch(`/api/team/${encodeURIComponent(teamName)}/meta`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ member_phone: memberPhone, ...patch }),
      });
      void refresh();
    } finally { setBusyPhone(null); }
  }

  const byPhone = new Map(meta.map(m => [m.member_phone, m]));

  return (
    <section className="dash-card overflow-hidden">
      <div className="px-5 py-4 border-b border-[#E8E3ED]">
        <h3 className="dash-h2 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-[#6E49E8]" />
          Member dates
        </h3>
        <div className="text-[11.5px] text-[#737373] mt-1">
          Birthdays + work anniversaries get auto-celebrated at 9am local with a team broadcast.
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="bg-[#FBFAFE] text-left text-[10.5px] uppercase tracking-wider text-[#737373] border-b border-[#E8E3ED]">
              <th className="px-5 py-2 font-semibold">Member</th>
              <th className="px-3 py-2 font-semibold">Birthday</th>
              <th className="px-3 py-2 font-semibold">Joined</th>
              <th className="px-3 py-2 font-semibold">Manager</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m, i, arr) => {
              const cur = byPhone.get(m.member_phone);
              return (
                <tr key={m.member_phone} className={i !== arr.length - 1 ? "border-b border-[#E8E3ED]" : ""}>
                  <td className="px-5 py-2.5 truncate max-w-[180px]">{m.member_name || `+${m.member_phone}`}</td>
                  <td className="px-3 py-2.5">
                    <input
                      type="date"
                      defaultValue={cur?.birthday || ""}
                      onBlur={(e) => save(m.member_phone, { birthday: e.target.value || null })}
                      disabled={busyPhone === m.member_phone}
                      className="dash-input !text-[12px] !py-1"
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <input
                      type="date"
                      defaultValue={cur?.joined_at || ""}
                      onBlur={(e) => save(m.member_phone, { joined_at: e.target.value || null })}
                      disabled={busyPhone === m.member_phone}
                      className="dash-input !text-[12px] !py-1"
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <select
                      defaultValue={cur?.manager_phone || ""}
                      onChange={(e) => save(m.member_phone, { manager_phone: e.target.value || null })}
                      disabled={busyPhone === m.member_phone}
                      className="dash-input !text-[12px] !py-1"
                    >
                      <option value="">—</option>
                      {members.filter(x => x.member_phone !== m.member_phone).map(x => (
                        <option key={x.member_phone} value={x.member_phone}>{x.member_name || `+${x.member_phone}`}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── 1:1s ───────────────────────────────────────────────────────────────

function OneOnOnesPanel({ teamName, members }: { teamName: string; members: Member[] }) {
  const [list, setList] = useState<OneOnOne[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [managerPhone, setManagerPhone] = useState("");
  const [reportPhone, setReportPhone] = useState("");
  const [nextAt, setNextAt] = useState("");
  const [agenda, setAgenda] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/one-on-ones`, { cache: "no-store" });
      const d = await r.json();
      if (d.ok) setList(d.oneOnOnes);
    } catch { /* swallow */ }
  }
  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [teamName]);

  async function add() {
    if (!managerPhone || !reportPhone || !nextAt) { setError("All fields required"); return; }
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/one-on-ones`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          manager_phone: managerPhone,
          report_phone: reportPhone,
          next_at: new Date(nextAt).toISOString(),
          agenda: agenda || null,
        }),
      });
      const d = await r.json();
      if (!d.ok) { setError(d.error || "Could not add."); return; }
      setShowAdd(false); setManagerPhone(""); setReportPhone(""); setNextAt(""); setAgenda("");
      void refresh();
    } finally { setBusy(false); }
  }

  async function del(id: number) {
    if (!confirm("Delete this 1:1?")) return;
    await fetch(`/api/team/${encodeURIComponent(teamName)}/one-on-ones/${id}`, { method: "DELETE" });
    void refresh();
  }

  return (
    <section className="dash-card overflow-hidden">
      <div className="px-5 py-4 border-b border-[#E8E3ED] flex items-center justify-between">
        <h3 className="dash-h2 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-[#FFB1D8]" />
          1:1s
        </h3>
        <button onClick={() => setShowAdd(s => !s)} className="dash-btn !text-[12px]">
          {showAdd ? "Cancel" : "+ Schedule"}
        </button>
      </div>

      {showAdd && (
        <div className="px-5 py-4 bg-[#FBFAFE]/40 border-b border-[#E8E3ED] space-y-3">
          {error && <div className="dash-card bg-[#FFB1D8]/30 border border-[#FFB1D8] px-3 py-2 text-[13px]">⚠️ {error}</div>}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="dash-label block mb-1.5">Manager *</label>
              <select value={managerPhone} onChange={(e) => setManagerPhone(e.target.value)} className="dash-input w-full">
                <option value="">Pick…</option>
                {members.map(m => <option key={m.member_phone} value={m.member_phone}>{m.member_name || `+${m.member_phone}`}</option>)}
              </select>
            </div>
            <div>
              <label className="dash-label block mb-1.5">Report *</label>
              <select value={reportPhone} onChange={(e) => setReportPhone(e.target.value)} className="dash-input w-full">
                <option value="">Pick…</option>
                {members.filter(m => m.member_phone !== managerPhone).map(m => <option key={m.member_phone} value={m.member_phone}>{m.member_name || `+${m.member_phone}`}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="dash-label block mb-1.5">Next at *</label>
            <input type="datetime-local" value={nextAt} onChange={(e) => setNextAt(e.target.value)} className="dash-input w-full" />
            <div className="text-[11px] text-[#a3a3a3] mt-1">Both will get a prep ping ~24 hours before.</div>
          </div>
          <div>
            <label className="dash-label block mb-1.5">Agenda (optional)</label>
            <input value={agenda} onChange={(e) => setAgenda(e.target.value)} className="dash-input w-full" />
          </div>
          <button onClick={add} disabled={busy} className="dash-btn dash-btn-primary disabled:opacity-40">
            {busy ? "Scheduling…" : "Schedule"}
          </button>
        </div>
      )}

      {list.length === 0 ? (
        <div className="text-[13px] text-[#737373] py-6 text-center px-5">No 1:1s scheduled.</div>
      ) : (
        <ul>
          {list.map((x, i, arr) => (
            <li key={x.id} className={`px-5 py-3 ${i !== arr.length - 1 ? "border-b border-[#E8E3ED]" : ""} flex items-center justify-between gap-3`}>
              <div className="flex-1 min-w-0">
                <div className="text-[13.5px] font-medium truncate">
                  {x.manager_name || `+${x.manager_phone}`} ↔ {x.report_name || `+${x.report_phone}`}
                </div>
                <div className="text-[11.5px] text-[#737373] mt-0.5">
                  {fmtTs(x.next_at)} {x.agenda ? `· ${x.agenda}` : ""}
                </div>
              </div>
              <button onClick={() => del(x.id)} className="text-[#a3a3a3] hover:text-[#ef4444] px-2">×</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ─── New-hire onboarding ────────────────────────────────────────────────

function OnboardingPanel({ teamName, members }: { teamName: string; members: Member[] }) {
  const [list, setList] = useState<Onboarding[]>([]);
  const [pickPhone, setPickPhone] = useState("");

  async function refresh() {
    try {
      const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/onboardings`, { cache: "no-store" });
      const d = await r.json();
      if (d.ok) setList(d.onboardings);
    } catch { /* swallow */ }
  }
  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [teamName]);

  async function start() {
    if (!pickPhone) return;
    await fetch(`/api/team/${encodeURIComponent(teamName)}/onboardings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ member_phone: pickPhone }),
    });
    setPickPhone("");
    void refresh();
  }

  async function complete(id: number) {
    await fetch(`/api/team/${encodeURIComponent(teamName)}/onboardings/${id}/complete`, { method: "POST" });
    void refresh();
  }

  const active = list.filter(x => !x.completed_at);
  const done = list.filter(x => x.completed_at).slice(0, 5);

  return (
    <section className="dash-card overflow-hidden">
      <div className="px-5 py-4 border-b border-[#E8E3ED]">
        <h3 className="dash-h2 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-[#8A65FF]" />
          New-hire onboarding
        </h3>
        <div className="text-[11.5px] text-[#737373] mt-1">
          Marks a member as new. Ari DMs them paced nudges (Day 1 → 3 → 7 → 14).
        </div>
      </div>

      <div className="px-5 py-3 bg-[#FBFAFE]/40 border-b border-[#E8E3ED] flex items-center gap-2">
        <select value={pickPhone} onChange={(e) => setPickPhone(e.target.value)} className="dash-input flex-1 !text-[12px]">
          <option value="">Pick a member…</option>
          {members.filter(m => !active.find(o => o.member_phone === m.member_phone)).map(m => (
            <option key={m.member_phone} value={m.member_phone}>{m.member_name || `+${m.member_phone}`}</option>
          ))}
        </select>
        <button onClick={start} disabled={!pickPhone} className="dash-btn dash-btn-primary !text-[12px] disabled:opacity-40">
          Start onboarding
        </button>
      </div>

      {active.length === 0 ? (
        <div className="text-[13px] text-[#737373] py-6 text-center">No active onboardings.</div>
      ) : (
        <ul>
          {active.map((o, i, arr) => (
            <li key={o.id} className={`px-5 py-3 ${i !== arr.length - 1 ? "border-b border-[#E8E3ED]" : ""} flex items-center justify-between gap-3`}>
              <div>
                <div className="text-[13.5px] font-medium">{o.member_name || `+${o.member_phone}`}</div>
                <div className="text-[11.5px] text-[#737373] mt-0.5">
                  Started {fmtAgo(o.started_at)} · {o.last_nudge_idx + 1}/4 nudges sent
                </div>
              </div>
              <button onClick={() => complete(o.id)} className="dash-btn !text-[11px]">Mark complete</button>
            </li>
          ))}
        </ul>
      )}
      {done.length > 0 && (
        <details className="border-t border-[#E8E3ED]">
          <summary className="cursor-pointer px-5 py-3 text-[12.5px] text-[#737373] hover:bg-[#FBFAFE] transition-colors">
            Recently completed ({done.length})
          </summary>
          <ul>
            {done.map((o, i, arr) => (
              <li key={o.id} className={`px-5 py-2 ${i !== arr.length - 1 ? "border-b border-[#E8E3ED]" : ""} text-[13px] text-[#737373]`}>
                {o.member_name || `+${o.member_phone}`} <span className="text-[11px] text-[#a3a3a3]">· completed {fmtAgo(o.completed_at!)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

// ─── Public team page ───────────────────────────────────────────────────

function PublicPagePanel({ teamName }: { teamName: string }) {
  const [meta, setMeta] = useState<{ slug: string | null; public_enabled: boolean; tagline: string | null } | null>(null);
  const [slug, setSlug] = useState("");
  const [tagline, setTagline] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/public`, { cache: "no-store" });
      const d = await r.json();
      if (d.ok) {
        setMeta(d.meta);
        setSlug(d.meta.slug || "");
        setTagline(d.meta.tagline || "");
        setEnabled(!!d.meta.public_enabled);
      }
    } catch { /* swallow */ }
  }
  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [teamName]);

  async function save() {
    setBusy(true);
    try {
      await fetch(`/api/team/${encodeURIComponent(teamName)}/public`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: slug || null, tagline: tagline || null, public_enabled: enabled }),
      });
      void refresh();
    } finally { setBusy(false); }
  }

  const publicUrl = meta?.slug ? `${typeof window !== "undefined" ? window.location.origin : ""}/p/${meta.slug}` : null;

  return (
    <section className="dash-card overflow-hidden">
      <div className="px-5 py-4 border-b border-[#E8E3ED]">
        <h3 className="dash-h2 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-[#9F7BD3]" />
          Public team page
        </h3>
        <div className="text-[11.5px] text-[#737373] mt-1">
          Optional shareable summary at <span className="font-mono">/p/your-slug</span>. Sanitized — no member-level data, no
          message content.
        </div>
      </div>
      <div className="px-5 py-4 space-y-3">
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enable public page
        </label>
        <div>
          <label className="dash-label block mb-1.5">Slug</label>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
            placeholder="acme-team"
            className="dash-input w-full"
          />
        </div>
        <div>
          <label className="dash-label block mb-1.5">Tagline</label>
          <input
            value={tagline}
            onChange={(e) => setTagline(e.target.value)}
            placeholder="A 12-person team building Ari."
            className="dash-input w-full"
          />
        </div>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          {publicUrl && enabled && meta?.slug && (
            <a href={publicUrl} target="_blank" rel="noreferrer" className="text-[12px] text-[#0a0a0a] underline">
              {publicUrl}
            </a>
          )}
          <button onClick={save} disabled={busy} className="dash-btn dash-btn-primary disabled:opacity-40 ml-auto">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </section>
  );
}

function fmtAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const days = Math.round((Date.now() - t) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}
function fmtTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}
