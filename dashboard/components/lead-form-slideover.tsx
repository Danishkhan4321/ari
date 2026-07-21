"use client";

// A right-side slide-over for creating a lead manually — the Folk-style
// "+ New lead" flow. Only Name is required; everything else is optional.
// On email blur it calls /api/contacts/check-dup and shows a non-blocking
// "already exists" warning. ESC or clicking the overlay closes it.
import { useEffect, useRef, useState } from "react";
import { PRIORITIES, PRIORITY_LABELS } from "@/lib/crm-shared";

type FormState = {
  name: string;
  email: string;
  company: string;
  title: string;
  source: string;
  deal_value: string;
  priority: string;
  notes: string;
  linkedin_url: string;
  website: string;
};

const EMPTY: FormState = {
  name: "", email: "", company: "", title: "", source: "manual",
  deal_value: "", priority: "", notes: "", linkedin_url: "", website: "",
};

export function LeadFormSlideOver({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dup, setDup] = useState<{ id: number; name: string } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // Reset whenever the panel opens; focus the name field.
  useEffect(() => {
    if (!open) return;
    setForm(EMPTY);
    setError(null);
    setDup(null);
    const t = setTimeout(() => nameRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [open]);

  // ESC closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function checkDup() {
    const email = form.email.trim();
    if (!email) { setDup(null); return; }
    try {
      const r = await fetch(`/api/contacts/check-dup?email=${encodeURIComponent(email)}`, { cache: "no-store" });
      const d = (await r.json()) as { exists?: boolean; lead?: { id: number; name: string } | null };
      setDup(d.exists && d.lead ? d.lead : null);
    } catch { /* non-blocking */ }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) { setError("Name is required."); nameRef.current?.focus(); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/contacts/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; id?: number; error?: string };
      if (!res.ok || !data.ok || !data.id) {
        setError(data.error || "Could not create the lead.");
        return;
      }
      onCreated(data.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {/* Overlay */}
      <div
        className={`fixed inset-0 bg-black/30 z-40 transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={onClose}
        aria-hidden
      />
      {/* Panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="New lead"
        className={`fixed top-0 right-0 h-full w-full max-w-[440px] bg-white z-50
                    border-l border-ari-border shadow-[0_20px_60px_rgba(38,8,5,0.16)] overflow-y-auto
                    transition-transform duration-200 ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <form onSubmit={submit} className="p-6 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="dash-h2 text-[17px]">New lead</h2>
            <button
              type="button"
              onClick={onClose}
              className="text-txt-muted hover:text-black text-2xl leading-none px-1"
              aria-label="Close"
            >
              ×
            </button>
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">{error}</div>
          )}

          <FieldRow label="Name" required>
            <input ref={nameRef} value={form.name} onChange={set("name")} className="dash-input" placeholder="Jane Doe" />
          </FieldRow>

          <FieldRow label="Email">
            <input
              type="email"
              value={form.email}
              onChange={(e) => { setForm((f) => ({ ...f, email: e.target.value })); if (dup) setDup(null); }}
              onBlur={checkDup}
              className="dash-input"
              placeholder="jane@acme.com"
            />
            {dup && (
              <p className="mt-1.5 text-[12px] text-txt-muted">
                ⚠ A lead with this email already exists:{" "}
                <a href={`/contacts/${dup.id}`} className="font-semibold underline underline-offset-2">{dup.name}</a>.
                Creating will add a second record.
              </p>
            )}
          </FieldRow>

          <div className="grid grid-cols-2 gap-3">
            <FieldRow label="Company">
              <input value={form.company} onChange={set("company")} className="dash-input" placeholder="Acme Inc" />
            </FieldRow>
            <FieldRow label="Title">
              <input value={form.title} onChange={set("title")} className="dash-input" placeholder="VP Sales" />
            </FieldRow>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <FieldRow label="Deal value ($)">
              <input
                type="number"
                inputMode="decimal"
                value={form.deal_value}
                onChange={set("deal_value")}
                className="dash-input"
                placeholder="50000"
              />
            </FieldRow>
            <FieldRow label="Priority">
              <select value={form.priority} onChange={set("priority")} className="dash-input">
                <option value="">—</option>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
                ))}
              </select>
            </FieldRow>
          </div>

          <FieldRow label="Source">
            <input value={form.source} onChange={set("source")} className="dash-input" placeholder="manual" />
          </FieldRow>

          <FieldRow label="LinkedIn URL">
            <input value={form.linkedin_url} onChange={set("linkedin_url")} className="dash-input" placeholder="https://linkedin.com/in/…" />
          </FieldRow>

          <FieldRow label="Website">
            <input value={form.website} onChange={set("website")} className="dash-input" placeholder="https://acme.com" />
          </FieldRow>

          <FieldRow label="Notes">
            <textarea value={form.notes} onChange={set("notes")} rows={3} className="dash-input resize-none leading-relaxed" placeholder="Context, next steps…" />
          </FieldRow>

          <div className="flex items-center gap-2 pt-2">
            <button type="submit" disabled={saving} className="dash-btn dash-btn-primary">
              {saving ? "Creating…" : "Create lead"}
            </button>
            <button type="button" onClick={onClose} className="dash-btn">Cancel</button>
          </div>
        </form>
      </aside>
    </>
  );
}

function FieldRow({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="dash-label mb-1.5">
        {label}{required && <span className="text-card-orange ml-0.5">*</span>}
      </span>
      {children}
    </label>
  );
}
