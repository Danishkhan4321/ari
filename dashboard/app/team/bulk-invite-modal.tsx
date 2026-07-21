"use client";

// Bulk-invite modal — admin pastes N members at once. We parse:
//   "Ravi Kumar, +91 9876543210"   (comma)
//   "Priya 9876543210"             (space)
//   "Ankit\t+919876543212"         (tab)
//   "Anu Sharma — 9876543213"      (em-dash)
// One pair per line. Invalid lines are surfaced for the admin to fix.
import { useEffect, useState } from "react";

type Row = { name: string; phone: string };

export function BulkInviteModal({
  open, onClose, teamName, onAdded,
}: {
  open: boolean; onClose: () => void; teamName: string;
  onAdded: (result: { added: number; skipped: number; welcomed: number }) => void;
}) {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<{ rows: Row[]; bad: string[] }>({ rows: [], bad: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendWelcome, setSendWelcome] = useState(true);

  useEffect(() => {
    if (!open) { setText(""); setParsed({ rows: [], bad: [] }); setError(null); }
  }, [open]);

  // Re-parse whenever text changes
  useEffect(() => {
    setParsed(parseLines(text));
  }, [text]);

  async function submit() {
    if (parsed.rows.length === 0) { setError("No valid rows yet."); return; }
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/members/bulk`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows: parsed.rows, sendWelcome }),
      });
      const d = await r.json();
      if (!d.ok) { setError(d.error || "Could not add."); return; }
      onAdded({ added: d.added, skipped: d.skipped, welcomed: d.welcomed });
    } finally { setBusy(false); }
  }

  if (!open) return null;
  return (
    <div className="crm-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="bulk-invite-title" onMouseDown={onClose}>
      <div onMouseDown={(e) => e.stopPropagation()} className="crm-modal max-w-[650px]">
        <div className="border-b border-[#e5e3df] px-5 py-4">
          <div className="crm-label">Team {teamName}</div>
          <h2 id="bulk-invite-title" className="mt-1 text-[14px] font-semibold tracking-[-0.02em] text-[#24211f]">Bulk invite members</h2>
        </div>
        <div className="px-5 py-4 space-y-3">
          {error && <div className="border border-[#e9caca] bg-[#fffafa] px-3 py-2 text-[11.5px] text-[#8d2727]">{error}</div>}
          <div>
            <label className="crm-label mb-1.5 block">Paste members (one per line)</label>
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              placeholder={`Ravi Kumar, +91 9876543210
Priya 9876543211
Ankit Singh\t+91 98765 43212`}
              className="crm-textarea min-h-[210px] w-full font-mono"
            />
            <div className="text-[11px] text-[#a3a3a3] mt-1">
              Format: <span className="font-mono">Name, Phone</span> · Tab or comma or space separator. We&apos;ll parse anything reasonable.
            </div>
          </div>

          {(parsed.rows.length > 0 || parsed.bad.length > 0) && (
            <div className="crm-panel overflow-hidden">
              <div className="px-3 py-2 bg-[#FBFAFE] border-b border-[#E8E3ED] flex items-center justify-between text-[11px]">
                <span className="font-semibold">
                  {parsed.rows.length} valid {parsed.bad.length > 0 && <span className="text-[#ef4444]">· {parsed.bad.length} invalid</span>}
                </span>
              </div>
              <div className="max-h-[180px] overflow-y-auto">
                {parsed.rows.map((r, i) => (
                  <div key={i} className="px-3 py-1.5 border-b border-[#E8E3ED] flex items-center gap-3 text-[12.5px]">
                    <span className="text-[#3FAA6E]">✓</span>
                    <span className="font-medium truncate flex-1">{r.name}</span>
                    <span className="font-mono text-[#737373]">+{r.phone}</span>
                  </div>
                ))}
                {parsed.bad.map((b, i) => (
                  <div key={i} className="px-3 py-1.5 border-b border-[#E8E3ED] text-[12.5px] flex items-center gap-3">
                    <span className="text-[#ef4444]">✗</span>
                    <span className="truncate text-[#737373] italic">{b}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <label className="flex items-center gap-2 text-[12.5px]">
            <input type="checkbox" checked={sendWelcome} onChange={(e) => setSendWelcome(e.target.checked)} />
            Send each new member a WhatsApp welcome from Ari
          </label>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[#e5e3df] px-5 py-4">
          <button onClick={onClose} className="crm-button">Cancel</button>
          <button
            onClick={submit}
            disabled={busy || parsed.rows.length === 0}
            className="crm-button crm-button-primary disabled:opacity-40"
          >
            {busy ? "Inviting…" : `Invite ${parsed.rows.length} member${parsed.rows.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// Pull a name + a 7-15 digit phone out of any single line.
function parseLines(text: string): { rows: Row[]; bad: string[] } {
  const rows: Row[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const phoneMatch = line.match(/(\+?\d[\d\s\-().]{6,})/);
    const phone = phoneMatch ? phoneMatch[0].replace(/\D/g, "") : "";
    if (!phone || phone.length < 7) { bad.push(line); continue; }
    const namePart = line.replace(phoneMatch![0], "").replace(/[,\-—|\t]+/g, " ").trim();
    const name = namePart.replace(/\s+/g, " ");
    if (!name) { bad.push(line); continue; }
    rows.push({ name: name.slice(0, 120), phone });
  }
  return { rows, bad };
}
