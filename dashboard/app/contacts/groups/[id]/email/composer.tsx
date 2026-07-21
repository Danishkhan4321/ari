"use client";

// Two-step composer:
//   1. Compose — subject + body with /-menu to insert variables
//      ({first_name}, {company}, {email}). Real-time count of recipients.
//   2. Review — per-recipient compiled email, editable inline. Then
//      Send Now or Schedule.
import { useEffect, useMemo, useRef, useState } from "react";

type Member = {
  member_kind: "lead" | "contact"; member_id: number;
  name: string; email: string | null; phone: string | null; company: string | null;
};

type Draft = {
  member_kind: "lead" | "contact"; member_id: number;
  to: string; subject: string; body: string;
};

const VARIABLES = [
  { token: "{first_name}", label: "First name", example: "Venkata" },
  { token: "{name}",       label: "Full name",  example: "Venkata Sriram Kalaga" },
  { token: "{email}",      label: "Email",      example: "venkata@example.com" },
  { token: "{company}",    label: "Company",    example: "Acme Corp" },
];

export function EmailComposer({ groupId }: { groupId: number }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [groupName, setGroupName] = useState<string>("");
  const [step, setStep] = useState<"compose" | "review">("compose");
  const [subject, setSubject] = useState("");
  const [bodyTpl, setBodyTpl] = useState("Hi {first_name},\n\n");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scheduledFor, setScheduledFor] = useState<string>(""); // datetime-local string
  const [dailyLimit, setDailyLimit] = useState(100);
  const [trackOpens, setTrackOpens] = useState(true);
  const [showSlash, setShowSlash] = useState<{ field: "subject" | "body"; pos: number } | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Load members. If the URL has ?only=lead-1,lead-3 (set by the
  // group-detail multi-select bar), pre-filter to just those members so
  // the user can email a hand-picked subset of the group.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/groups/${groupId}`, { cache: "no-store" })
      .then(r => r.json())
      .then((d: { ok: boolean; group?: { name: string }; members?: Member[]; error?: string }) => {
        if (cancelled) return;
        if (!d.ok) { setError(d.error || "Could not load group."); return; }
        const sendable = (d.members || []).filter(m => m.email);
        const sp = new URLSearchParams(window.location.search);
        const only = sp.get("only");
        const limitFromUrl = Number(sp.get("dailyLimit"));
        if (Number.isInteger(limitFromUrl) && limitFromUrl > 0 && limitFromUrl <= 2000) setDailyLimit(limitFromUrl);
        let filtered = sendable;
        if (only) {
          const allowed = new Set(only.split(",").map(s => s.trim()).filter(Boolean));
          filtered = sendable.filter(m => allowed.has(`${m.member_kind}-${m.member_id}`));
          if (filtered.length === 0) filtered = sendable; // fall back if filter wipes everyone
        }
        setMembers(filtered);
        setGroupName(d.group?.name || "");
      })
      .catch(e => !cancelled && setError(String(e)));
    return () => { cancelled = true; };
  }, [groupId]);

  function firstName(fullName: string): string {
    return String(fullName || "").trim().split(/\s+/)[0] || "";
  }

  function fillTemplate(tpl: string, m: Member): string {
    return tpl
      .replace(/\{first_name\}/g, firstName(m.name))
      .replace(/\{name\}/g, m.name)
      .replace(/\{email\}/g, m.email || "")
      .replace(/\{company\}/g, m.company || "");
  }

  function goToReview() {
    if (!members) return;
    if (!subject.trim() || !bodyTpl.trim()) {
      setError("Subject and body are required.");
      return;
    }
    const compiled = members.map(m => ({
      member_kind: m.member_kind,
      member_id: m.member_id,
      to: m.email!,
      subject: fillTemplate(subject, m),
      body: fillTemplate(bodyTpl, m),
    }));
    setDrafts(compiled);
    setStep("review");
    setError(null);
  }

  async function send() {
    if (drafts.length === 0) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/groups/${groupId}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject: subject.trim(),
          body: bodyTpl,
          drafts,
          track: trackOpens,
          dailyLimit,
          scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : undefined,
        }),
      });
      const d = (await res.json()) as { ok: boolean; campaign_id?: number; sent?: number; failed?: number; failedRecipients?: string[]; scheduled?: boolean; error?: string };
      if (!d.ok) {
        setError(d.error || "Send failed.");
      } else if (d.scheduled) {
        window.location.href = `/contacts/campaigns?just=${d.campaign_id}`;
      } else {
        window.location.href = `/contacts/campaigns?just=${d.campaign_id}`;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
    } finally {
      setBusy(false);
    }
  }

  function insertVariable(field: "subject" | "body", token: string) {
    if (field === "subject") {
      const el = subjectRef.current;
      if (!el) return;
      const start = el.selectionStart ?? subject.length;
      const end = el.selectionEnd ?? subject.length;
      // Replace the trailing "/" with the variable token
      const before = subject.slice(0, start).replace(/\/$/, "");
      const after = subject.slice(end);
      const next = before + token + after;
      setSubject(next);
      setShowSlash(null);
      requestAnimationFrame(() => { el.focus(); el.setSelectionRange(before.length + token.length, before.length + token.length); });
    } else {
      const el = bodyRef.current;
      if (!el) return;
      const start = el.selectionStart ?? bodyTpl.length;
      const end = el.selectionEnd ?? bodyTpl.length;
      const before = bodyTpl.slice(0, start).replace(/\/$/, "");
      const after = bodyTpl.slice(end);
      const next = before + token + after;
      setBodyTpl(next);
      setShowSlash(null);
      requestAnimationFrame(() => { el.focus(); el.setSelectionRange(before.length + token.length, before.length + token.length); });
    }
  }

  function handleKey(field: "subject" | "body", e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (e.key === "/") {
      const el = e.currentTarget;
      const pos = el.selectionStart ?? 0;
      setTimeout(() => setShowSlash({ field, pos }), 0);
    } else if (e.key === "Escape") {
      setShowSlash(null);
    }
  }

  // ─── Render ────────────────────────────────────────────────────────
  if (members === null) {
    return <div className="text-txt-muted py-12 text-center">Loading members…</div>;
  }

  if (members.length === 0) {
    return (
      <div className="py-16 text-center">
        <div className="text-4xl mb-3">📭</div>
        <div className="font-semibold text-lg mb-1">No sendable members</div>
        <div className="text-txt-muted text-sm max-w-md mx-auto">
          Group <span className="font-semibold">{groupName}</span> has no members with email addresses.
          Add some via Import CSV first.
        </div>
        <a href={`/contacts/groups/${groupId}`} className="inline-block mt-5 px-4 py-2 border border-black/20 rounded-[6px] text-sm font-medium bg-white hover:bg-page">← Back</a>
      </div>
    );
  }

  if (step === "compose") {
    return (
      <div className="space-y-5">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <p className="mb-1.5 text-[9px] font-medium uppercase tracking-[0.1em] text-[#77736f]">Campaign · {groupName}</p>
            <h1 className="text-[22px] font-semibold leading-[1.2] tracking-[-0.035em] text-[#171717]">Compose email</h1>
            <p className="mt-1.5 text-[11.5px] text-[#77736f]">
              {members.length} {members.length === 1 ? "recipient" : "recipients"}. Type <span className="font-mono text-[13px] bg-page px-1.5 py-0.5 rounded border border-black/10">/</span> to insert a variable.
            </p>
          </div>
          <button
            onClick={() => setAiOpen(true)}
            className="crm-button shrink-0"
          >
            <SparkleIcon /> Write with AI
          </button>
        </div>

        {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[12px] text-red-700">{error}</div>}

        <div className="crm-panel space-y-4 p-5">
          <div className="relative">
            <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.12em] text-ari-muted">Subject</label>
            <input
              ref={subjectRef}
              type="text" value={subject} onChange={(e) => setSubject(e.target.value)}
              onKeyDown={(e) => handleKey("subject", e)}
              placeholder="Quick intro · {company}"
              className="crm-input"
            />
            {showSlash?.field === "subject" && <SlashMenu onPick={(t) => insertVariable("subject", t)} onClose={() => setShowSlash(null)} />}
          </div>
          <div className="relative">
            <label className="mb-1.5 block text-[10px] font-medium uppercase tracking-[0.12em] text-ari-muted">Body</label>
            <textarea
              ref={bodyRef}
              value={bodyTpl} onChange={(e) => setBodyTpl(e.target.value)}
              onKeyDown={(e) => handleKey("body", e)}
              rows={14}
              placeholder="Hi {first_name},&#10;&#10;…"
              className="crm-textarea min-h-[260px] font-sans leading-relaxed"
            />
            {showSlash?.field === "body" && <SlashMenu onPick={(t) => insertVariable("body", t)} onClose={() => setShowSlash(null)} />}
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-txt-muted">
            <span>Variables:</span>
            {VARIABLES.map(v => (
              <button
                key={v.token}
                onClick={() => insertVariable("body", v.token)}
                className="rounded-md border border-ari-border bg-white px-1.5 py-0.5 font-mono text-[10.5px] hover:bg-ari-nav-active"
              >{v.token}</button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-end gap-3">
          <a href={`/contacts/groups/${groupId}`} className="crm-button">Cancel</a>
          <button
            onClick={goToReview}
            disabled={!subject.trim() || !bodyTpl.trim()}
            className="crm-button crm-button-primary"
          >
            Review {members.length} email{members.length === 1 ? "" : "s"} →
          </button>
        </div>

        <AiWriteModal
          open={aiOpen}
          onClose={() => setAiOpen(false)}
          groupName={groupName}
          sampleMember={members[0] || null}
          onApply={(s, b) => { setSubject(s); setBodyTpl(b); setAiOpen(false); }}
        />
      </div>
    );
  }

  // ─── Review step ──────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      <div>
        <p className="mb-1.5 text-[9px] font-medium uppercase tracking-[0.1em] text-[#77736f]">Review · {groupName}</p>
        <h1 className="text-[22px] font-semibold leading-[1.2] tracking-[-0.035em] text-[#171717]">{drafts.length} ready to send</h1>
        <p className="mt-1.5 text-[11.5px] text-[#77736f]">
          Each email is personalized below. Click any to edit individually before sending.
        </p>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[12px] text-red-700">{error}</div>}

      <ul className="space-y-3">
        {drafts.map((d, idx) => (
          <DraftRow
            key={`${d.member_kind}-${d.member_id}`}
            draft={d}
            onEdit={(next) => {
              const arr = drafts.slice();
              arr[idx] = next;
              setDrafts(arr);
            }}
          />
        ))}
      </ul>

      <div className="crm-panel grid gap-4 p-4 lg:grid-cols-[1fr_1fr_auto] lg:items-end">
        <label><span className="crm-label">Schedule</span><div className="flex items-center gap-2 text-sm">
          <input
            type="datetime-local"
            value={scheduledFor}
            onChange={(e) => setScheduledFor(e.target.value)}
            className="crm-input w-auto"
          />
          {scheduledFor && (
            <button onClick={() => setScheduledFor("")} className="text-txt-muted hover:text-black text-sm" aria-label="Clear">clear</button>
          )}
        </div></label>
        <label><span className="crm-label">Daily sending limit</span><input type="number" min="1" max="2000" value={dailyLimit} onChange={(e) => setDailyLimit(Math.max(1, Math.min(2000, Number(e.target.value) || 1)))} className="crm-input" /><span className="mt-1 block text-[9.5px] text-[#77736f]">{Math.max(1, Math.ceil(drafts.length / Math.max(1, dailyLimit)))} estimated day(s)</span></label>
        <div className="flex flex-wrap items-center justify-end gap-3">
        <label className="flex items-center gap-2 text-[11px] text-[#77736f] cursor-pointer select-none" title="Adds a 1×1 pixel to detect opens. Turn off for max deliverability.">
          <input type="checkbox" checked={trackOpens} onChange={(e) => setTrackOpens(e.target.checked)} className="accent-black" />
          Track opens
        </label>
          <button onClick={() => setStep("compose")} className="crm-button">Edit template</button>
          <button
            onClick={send}
            disabled={busy}
            className="crm-button crm-button-primary"
          >
            {busy ? "Sending…" : scheduledFor ? `Schedule ${drafts.length}` : `Send ${drafts.length} now`}
          </button>
        </div>
      </div>
    </div>
  );
}

function SlashMenu({ onPick, onClose }: { onPick: (token: string) => void; onClose: () => void }) {
  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div className="absolute z-40 left-3 mt-1 w-72 bg-white border border-black/20 rounded-[8px] shadow-[0_4px_16px_rgba(0,0,0,0.08)] overflow-hidden">
        <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider font-bold text-txt-muted bg-page border-b border-black/10">Insert variable</div>
        <ul>
          {VARIABLES.map(v => (
            <li key={v.token}>
              <button
                onClick={() => onPick(v.token)}
                className="w-full text-left px-3 py-2 hover:bg-card-lemon/30 transition-colors flex items-center justify-between"
              >
                <span>
                  <span className="block font-medium text-[14px]">{v.label}</span>
                  <span className="block text-[11px] text-txt-muted">e.g. {v.example}</span>
                </span>
                <span className="font-mono text-[11px] text-txt-muted">{v.token}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

function DraftRow({ draft, onEdit }: { draft: Draft; onEdit: (d: Draft) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="card-soft overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full text-left p-4 flex items-start justify-between gap-3"
      >
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider font-bold text-txt-muted mb-1">→ {draft.to}</div>
          <div className="font-semibold text-[15px] truncate">{draft.subject}</div>
          <div className="text-[13px] text-txt-muted mt-1 line-clamp-2 whitespace-pre-wrap">{draft.body.slice(0, 160)}{draft.body.length > 160 ? "…" : ""}</div>
        </div>
        <span className="text-txt-muted text-xl flex-shrink-0">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="border-t border-black/10 p-4 space-y-3 bg-page/40">
          <div>
            <label className="text-[11px] uppercase tracking-wider font-bold text-txt-muted mb-1.5 block">Subject</label>
            <input
              type="text" value={draft.subject}
              onChange={(e) => onEdit({ ...draft, subject: e.target.value })}
              className="w-full px-3 py-2 border border-black/15 rounded-[6px] text-[14px] bg-white"
            />
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wider font-bold text-txt-muted mb-1.5 block">Body</label>
            <textarea
              value={draft.body}
              onChange={(e) => onEdit({ ...draft, body: e.target.value })}
              rows={10}
              className="w-full px-3 py-2 border border-black/15 rounded-[6px] text-[14px] leading-relaxed bg-white"
            />
          </div>
        </div>
      )}
    </li>
  );
}

// ────────────────────────────────────────────────────────────────────────
// AI write modal — collects intent + tone, calls /api/ai/email-draft,
// previews the returned subject + body, and replaces the composer's
// state on "Use this draft". Designed so the user can iterate ("Try
// again") cheaply until the tone feels right.
function AiWriteModal({
  open, onClose, groupName, sampleMember, onApply,
}: {
  open: boolean;
  onClose: () => void;
  groupName: string;
  sampleMember: Member | null;
  onApply: (subject: string, body: string) => void;
}) {
  const [purpose, setPurpose] = useState("");
  const [tone, setTone] = useState<"friendly" | "professional" | "urgent" | "warm">("warm");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const purposeRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) {
      setPurpose(""); setTone("warm"); setBusy(false);
      setPreview(null); setErr(null);
    } else {
      setTimeout(() => purposeRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  async function generate() {
    if (purpose.trim().length < 3) { setErr("Tell me what the email is about (one sentence is enough)."); return; }
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/ai/email-draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          purpose: purpose.trim(),
          tone,
          group_name: groupName,
          sample_member: sampleMember
            ? { name: sampleMember.name, company: sampleMember.company }
            : null,
        }),
      });
      const d = (await r.json()) as { ok: boolean; subject?: string; body?: string; error?: string };
      if (!d.ok || !d.subject || !d.body) {
        setErr(d.error || "Couldn't generate a draft.");
        return;
      }
      setPreview({ subject: d.subject, body: d.body });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-12 pb-12 px-4 bg-black/40 overflow-y-auto"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl bg-white border border-black/15 rounded-[8px] shadow-[0_2px_4px_rgba(0,0,0,0.06),0_8px_28px_rgba(0,0,0,0.12)] overflow-hidden"
      >
        <div className="px-5 py-4 border-b border-black/10 flex items-start justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] font-bold text-txt-muted flex items-center gap-1.5">
              <SparkleIcon /> Write with AI
            </div>
            <h2 className="text-[18px] font-bold mt-0.5">
              Draft a personalized email for {groupName || "this group"}
            </h2>
          </div>
          <button onClick={onClose} className="text-2xl text-txt-muted hover:text-black px-2" aria-label="Close">×</button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {err && (
            <div className="px-3 py-2 text-[13px] bg-card-orange/30 border border-black/10 rounded-[6px]">⚠️ {err}</div>
          )}

          <div>
            <label className="text-[11px] uppercase tracking-wider font-bold text-txt-muted mb-1.5 block">
              What&apos;s this email about?
            </label>
            <textarea
              ref={purposeRef}
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              rows={3}
              placeholder={
                "e.g. Pitch our AI legal-research tool to immigration attorneys — 14-day free trial, no card needed. " +
                "I want them to book a 15-min demo."
              }
              className="w-full px-3 py-2.5 border border-black/15 rounded-[6px] text-[14px] focus:outline-none focus:border-black"
            />
            <div className="text-[11px] text-[#a3a3a3] mt-1">
              The more specific you are, the better the draft. Mention the offer + the ask.
            </div>
          </div>

          <div>
            <label className="text-[11px] uppercase tracking-wider font-bold text-txt-muted mb-1.5 block">Tone</label>
            <div className="inline-flex gap-1 bg-[#FBFAFE] border border-[#E8E3ED] rounded-[6px] p-0.5">
              {(["warm", "friendly", "professional", "urgent"] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setTone(t)}
                  className={`px-3 py-1 text-[12px] font-medium rounded-[4px] transition-colors ${
                    tone === t ? "bg-black text-white" : "text-[#525252] hover:text-black"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {preview && (
            <div className="border border-black/15 rounded-[6px] overflow-hidden bg-[#FBFAFE]">
              <div className="px-4 py-3 border-b border-black/10 flex items-center justify-between gap-3">
                <div className="text-[11px] uppercase tracking-wider font-bold text-txt-muted">Preview</div>
                <div className="text-[11px] text-[#737373]">
                  Variables auto-fill per recipient — <span className="font-mono">{"{first_name}"}</span> etc.
                </div>
              </div>
              <div className="px-4 py-3 space-y-2 bg-white">
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-bold text-txt-muted">Subject</div>
                  <div className="text-[14px] font-semibold mt-0.5">{preview.subject}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider font-bold text-txt-muted">Body</div>
                  <div className="text-[13px] whitespace-pre-wrap leading-relaxed mt-0.5 text-[#404040]">{preview.body}</div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-black/10 flex items-center justify-between gap-3 bg-page/40">
          <button onClick={onClose} className="text-[13px] text-[#737373] hover:text-black">Cancel</button>
          <div className="flex items-center gap-2">
            {preview && (
              <button
                onClick={generate}
                disabled={busy}
                className="px-3 py-2 text-[13px] font-medium border border-black/20 rounded-[6px] hover:bg-page disabled:opacity-40"
              >
                {busy ? "Regenerating…" : "Try again"}
              </button>
            )}
            {!preview ? (
              <button
                onClick={generate}
                disabled={busy || purpose.trim().length < 3}
                className="px-4 py-2 bg-black text-white rounded-[6px] text-sm font-semibold hover:bg-black/85 disabled:opacity-40 inline-flex items-center gap-1.5"
              >
                <SparkleIcon /> {busy ? "Drafting…" : "Generate draft"}
              </button>
            ) : (
              <button
                onClick={() => onApply(preview.subject, preview.body)}
                className="px-4 py-2 bg-black text-white rounded-[6px] text-sm font-semibold hover:bg-black/85"
              >
                Use this draft
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SparkleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 1.5l1.5 4 4 1.5-4 1.5L8 12.5 6.5 8.5 2.5 7l4-1.5L8 1.5z" />
      <path d="M13 11l.7 1.8L15.5 13.5l-1.8.7L13 16l-.7-1.8L10.5 13.5l1.8-.7L13 11z" opacity="0.6" />
    </svg>
  );
}
