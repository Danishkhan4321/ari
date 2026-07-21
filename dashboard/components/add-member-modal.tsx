"use client";

// Add a single contact to a group. Two paths:
//   1. AUTOCOMPLETE — type a name, see top matches from existing leads
//      and address-book contacts, click one to add. Already-in-group rows
//      are shown but greyed out as "Already added".
//   2. CREATE NEW — if no match exists (or user wants to skip), they can
//      type name + email/phone and we create a fresh sales_lead (or
//      contact) and add them to the group in one step.
//
// Submitted via /api/groups/[id]/members (existing route accepts a list).
import { useEffect, useMemo, useRef, useState } from "react";

type ExistingMember = { kind: "lead" | "contact"; id: number };
type Match = {
  kind: "lead" | "contact";
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
};

type Mode = "search" | "create";

export function AddMemberModal({
  open, onClose, groupId, groupName, existing, onAdded,
}: {
  open: boolean;
  onClose: () => void;
  groupId: number;
  groupName: string;
  existing: ExistingMember[];
  onAdded: () => void;
}) {
  const [mode, setMode] = useState<Mode>("search");
  const [q, setQ] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // create-new state
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [company, setCompany] = useState("");
  const [creating, setCreating] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  // Reset everything when reopened
  useEffect(() => {
    if (!open) return;
    setMode("search"); setQ(""); setMatches([]); setSearching(false);
    setError(null); setBusyId(null);
    setName(""); setEmail(""); setPhone(""); setCompany(""); setCreating(false);
    setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  // ESC closes
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Debounced autocomplete
  useEffect(() => {
    if (!open || mode !== "search") return;
    const term = q.trim();
    if (term.length === 0) { setMatches([]); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/contacts/list?q=${encodeURIComponent(term)}`, { cache: "no-store" });
        const d = (await res.json()) as { ok: boolean; leads?: Match[]; contacts?: Match[]; error?: string };
        if (!d.ok) { setError(d.error || "Search failed."); setMatches([]); return; }
        const leads = (d.leads || []).map(m => ({ ...m, kind: "lead" as const }));
        const contacts = (d.contacts || []).map(m => ({ ...m, kind: "contact" as const }));
        // Leads first (CRM-relevant), then contacts. Cap to 10 for UI.
        setMatches([...leads, ...contacts].slice(0, 10));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Search error.");
      } finally {
        setSearching(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [q, open, mode]);

  const existingSet = useMemo(() =>
    new Set(existing.map(m => `${m.kind}-${m.id}`)),
    [existing]
  );

  async function addExisting(m: Match) {
    const k = `${m.kind}-${m.id}`;
    if (existingSet.has(k)) return;
    setBusyId(k); setError(null);
    try {
      const res = await fetch(`/api/groups/${groupId}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ members: [{ kind: m.kind, id: m.id }] }),
      });
      const d = (await res.json()) as { ok: boolean; added?: number; error?: string };
      if (!d.ok) { setError(d.error || "Could not add."); return; }
      onAdded();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
    } finally {
      setBusyId(null);
    }
  }

  async function createAndAdd() {
    const trimmed = name.trim();
    const e = email.trim().toLowerCase();
    const p = phone.replace(/\D/g, "");
    if (!trimmed) { setError("Name is required."); return; }
    if (!e && !p) { setError("Either email or phone is required."); return; }
    setCreating(true); setError(null);
    try {
      const res = await fetch(`/api/contacts/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rows: [{ name: trimmed, email: e || undefined, phone: p || undefined, company: company.trim() || undefined }],
          assignToGroupId: groupId,
        }),
      });
      const d = (await res.json()) as { ok: boolean; imported?: number; addedToGroup?: number; error?: string };
      if (!d.ok) { setError(d.error || "Could not create."); return; }
      onAdded();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
    } finally {
      setCreating(false);
    }
  }

  if (!open) return null;
  const trimmed = q.trim();

  return (
    <div className="crm-modal-backdrop items-start pt-16" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="crm-modal max-w-lg"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-[#e5e3df] px-5 py-4">
          <div>
            <div className="text-[9px] font-medium uppercase tracking-[0.09em] text-[#77736f]">Add to group</div>
            <h2 className="mt-1 text-[14px] font-semibold tracking-[-0.02em] text-[#24211f]">{groupName}</h2>
          </div>
          <button onClick={onClose} className="crm-icon-button border-0" aria-label="Close">×</button>
        </div>

        {/* Mode tabs */}
        <div className="flex items-center gap-5 border-b border-[#e5e3df] px-5">
          <TabBtn active={mode === "search"} onClick={() => setMode("search")}>Find existing</TabBtn>
          <TabBtn active={mode === "create"} onClick={() => setMode("create")}>Create new</TabBtn>
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          {error && (
            <div className="mb-3 px-3 py-2 text-sm bg-card-orange/30 border border-black/10 rounded-[6px]">⚠️ {error}</div>
          )}

          {mode === "search" ? (
            <div>
              <input
                ref={inputRef}
                type="text"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Type a name, email, or company…"
                className="crm-input"
              />

              {trimmed.length > 0 && (
                <div className="mt-3">
                  {searching && matches.length === 0 ? (
                    <div className="text-[13px] text-txt-muted py-2">Searching…</div>
                  ) : matches.length === 0 ? (
                    <div className="py-4 text-center space-y-2">
                      <div className="text-[14px] text-txt-muted">No match for &quot;{trimmed}&quot;.</div>
                      <button
                        onClick={() => { setName(trimmed); setMode("create"); }}
                        className="inline-block px-3 py-1.5 text-[13px] font-medium border border-black/20 rounded-[5px] hover:bg-page"
                      >
                        + Create &quot;{trimmed}&quot; as a new contact
                      </button>
                    </div>
                  ) : (
                    <ul className="divide-y divide-black/5 border border-black/10 rounded-[6px] overflow-hidden">
                      {matches.map(m => {
                        const k = `${m.kind}-${m.id}`;
                        const isExisting = existingSet.has(k);
                        return (
                          <li key={k}>
                            <button
                              onClick={() => addExisting(m)}
                              disabled={isExisting || busyId === k}
                              className={`w-full text-left px-3 py-2.5 flex items-center justify-between gap-3 transition-colors ${
                                isExisting ? "opacity-50 cursor-not-allowed" : "hover:bg-card-lemon/30"
                              }`}
                            >
                              <div className="min-w-0 flex-1">
                                <div className="font-semibold text-[14px] truncate">{m.name}</div>
                                <div className="text-[12px] text-txt-muted truncate">
                                  {m.email || m.phone || "no contact info"}
                                  {m.company && <> · {m.company}</>}
                                </div>
                              </div>
                              <span className={`text-[11px] flex-shrink-0 ${isExisting ? "text-txt-muted" : "text-black"}`}>
                                {isExisting ? "Already in group" : busyId === k ? "Adding…" : "+ Add"}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}

              {trimmed.length === 0 && (
                <div className="mt-3 text-[12px] text-txt-muted">
                  Tip: search by name, email, or company. If they&apos;re not in your contacts yet, switch to <button onClick={() => setMode("create")} className="underline underline-offset-2 hover:text-black">Create new</button>.
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <Field label="Name *">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Full name"
                  className="w-full px-3 py-2 border border-black/15 rounded-[6px] text-[14px] outline-none focus:border-black/40"
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Email">
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@example.com"
                    className="w-full px-3 py-2 border border-black/15 rounded-[6px] text-[14px] outline-none focus:border-black/40"
                  />
                </Field>
                <Field label="Phone">
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+1 555 123 4567"
                    className="w-full px-3 py-2 border border-black/15 rounded-[6px] text-[14px] outline-none focus:border-black/40"
                  />
                </Field>
              </div>
              <Field label="Company">
                <input
                  type="text"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  placeholder="Acme Corp"
                  className="w-full px-3 py-2 border border-black/15 rounded-[6px] text-[14px] outline-none focus:border-black/40"
                />
              </Field>
              <div className="text-[11px] text-txt-muted">
                Provide email or phone (or both). With email → goes to leads. Phone-only → goes to address book.
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[#e5e3df] bg-[#faf9f5] px-5 py-4">
          <button onClick={onClose} className="crm-button">Cancel</button>
          {mode === "create" ? (
            <button
              onClick={createAndAdd}
              disabled={creating || !name.trim() || (!email.trim() && !phone.replace(/\D/g, ""))}
              className="crm-button crm-button-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              {creating ? "Adding…" : "Create & add"}
            </button>
          ) : (
            <span className="text-[12px] text-txt-muted">Click any match to add</span>
          )}
        </div>
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`relative px-0 py-2.5 text-[11.5px] font-medium transition-colors ${
        active ? "text-ari-ink" : "text-[#77736f] hover:text-ari-ink"
      }`}
    >
      {children}
      {active && <span className="absolute -bottom-px inset-x-0 h-[2px] rounded-full bg-ari-accent" />}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="crm-label">{label}</label>
      {children}
    </div>
  );
}
