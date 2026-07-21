"use client";

// Import CSV modal — three-step flow:
//   1. SOURCE: pick file OR paste a table (TSV from Sheets/Excel works).
//   2. MAP:    auto-detected column → field mapping, with dropdowns to
//              override every column. Live preview of first 3 rows + a
//              live count of valid (importable) rows.
//   3. RESULT: shows imported / skipped / added-to-group counts.
//
// On confirm, the modal POSTs to /api/contacts/import. The caller passes
// `assignToGroupId` (optional) and an `onImported` callback so the parent
// view can refresh.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type ColumnMapping,
  type CsvRow,
  type FieldKey,
  applyMapping,
  asCustom,
  countValid,
  customLabel,
  detectMapping,
  isCustom,
  parseCsv,
  analyzeMapping,
} from "@/lib/csv";

type Step = "source" | "map" | "result";

type ImportResult = {
  imported: number;
  matchedExisting: number;
  skipped: number;
  mergedDuplicates: number;
  addedToGroup: number;
};

export function ImportCsvModal({
  open, onClose, assignToGroupId, onImported,
}: {
  open: boolean;
  onClose: () => void;
  assignToGroupId?: number;
  onImported?: () => void;
}) {
  const [step, setStep] = useState<Step>("source");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<CsvRow[]>([]);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [customFields, setCustomFields] = useState<string[]>([]);
  const [paste, setPaste] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Reset state when reopened
  useEffect(() => {
    if (!open) return;
    setStep("source"); setHeaders([]); setRows([]); setMapping({});
    setCustomFields([]); setPaste(""); setError(null); setBusy(false); setResult(null);
  }, [open]);

  // ESC closes
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function ingest(text: string, sourceLabel: string) {
    const { headers: h, rows: r } = parseCsv(text);
    if (h.length === 0 || r.length === 0) {
      setError(`Couldn't parse ${sourceLabel}. Make sure the first row is the header and there's at least one data row.`);
      return;
    }
    setHeaders(h);
    setRows(r);
    setMapping(detectMapping(h));
    setError(null);
    setStep("map");
  }

  async function onFile(file: File) {
    try {
      const text = await file.text();
      ingest(text, "that file");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the file.");
    }
  }

  function onPasteSubmit() {
    const t = paste.trim();
    if (!t) { setError("Paste a table first."); return; }
    ingest(t, "the pasted text");
  }

  // Update one column's mapping. Multiple columns can share a field
  // (e.g. First Name + Last Name → name) — we don't auto-deduplicate.
  function setField(header: string, field: FieldKey) {
    setMapping(prev => ({ ...prev, [header]: field }));
  }

  const mapped = useMemo(() => applyMapping(rows, mapping), [rows, mapping]);
  const valid = useMemo(() => countValid(mapped), [mapped]);
  const analysis = useMemo(() => analyzeMapping(mapped), [mapped]);
  const skippedPreview = mapped.length - valid;

  async function onImport() {
    if (valid === 0) {
      setError("No rows have a name + email or phone yet. Adjust the mapping above.");
      return;
    }
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/contacts/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          // Send every row that has a name. Email + phone are optional —
          // the API places no-contact rows in sales_leads with NULL email
          // so they keep all their other data (name / company / title /
          // LinkedIn / etc.) and still get added to the group.
          rows: mapped.filter(r => r.name),
          assignToGroupId,
        }),
      });
      const d = (await res.json()) as {
        ok: boolean;
        imported?: number;
        matchedExisting?: number;
        skipped?: number;
        mergedDuplicates?: number;
        addedToGroup?: number;
        error?: string;
      };
      if (!d.ok) {
        setError(d.error || "Import failed.");
      } else {
        setResult({
          imported: d.imported ?? 0,
          matchedExisting: d.matchedExisting ?? 0,
          skipped: (d.skipped ?? 0) + skippedPreview,
          mergedDuplicates: d.mergedDuplicates ?? 0,
          addedToGroup: d.addedToGroup ?? 0,
        });
        setStep("result");
        onImported?.();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="crm-modal-backdrop items-start pt-12"
      onClick={onClose}
      // Swallow drops that miss the dropzone — without these handlers,
      // dropping a file on the overlay would navigate the whole tab to
      // the file (browser default).
      onDragOver={(e) => { e.preventDefault(); }}
      onDrop={(e) => { e.preventDefault(); }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="crm-modal max-w-3xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#e5e3df] px-5 py-4">
          <div>
            <div className="text-[9px] font-medium uppercase tracking-[0.09em] text-[#77736f]">Import contacts</div>
            <h2 className="mt-1 text-[14px] font-semibold tracking-[-0.02em] text-[#24211f]">
              {step === "source" && "Upload a CSV or paste a table"}
              {step === "map"    && `Match columns (${valid} of ${mapped.length} ready)`}
              {step === "result" && "Done"}
            </h2>
          </div>
          <button onClick={onClose} className="text-2xl text-txt-muted hover:text-black px-2" aria-label="Close">×</button>
        </div>

        {/* Body */}
        <div className="px-5 py-5">
          {error && (
            <div className="mb-4 px-3 py-2 text-sm bg-card-orange/30 border border-black/10 rounded-[6px]">⚠️ {error}</div>
          )}

          {step === "source" && (
            <SourceStep
              fileRef={fileRef}
              paste={paste}
              setPaste={setPaste}
              onFile={onFile}
              onPasteSubmit={onPasteSubmit}
            />
          )}

          {step === "map" && (
            <MapStep
              headers={headers}
              rows={rows}
              mapping={mapping}
              setField={setField}
              valid={valid}
              total={mapped.length}
              analysis={analysis}
              customFields={customFields}
              addCustomField={(label) => setCustomFields(prev => prev.includes(label) ? prev : [...prev, label])}
              removeCustomField={(label) => {
                setCustomFields(prev => prev.filter(l => l !== label));
                // Also un-map any column currently mapped to this custom field
                setMapping(prev => {
                  const next: ColumnMapping = {};
                  for (const [h, f] of Object.entries(prev)) {
                    next[h] = isCustom(f) && customLabel(f) === label ? "ignore" : f;
                  }
                  return next;
                });
              }}
            />
          )}

          {step === "result" && result && (
            <ResultStep result={result} onClose={onClose} />
          )}
        </div>

        {/* Footer */}
        {step !== "result" && (
          <div className="flex items-center justify-between border-t border-[#e5e3df] bg-[#faf9f5] px-5 py-4">
            <button onClick={onClose} className="crm-button">Cancel</button>
            {step === "map" && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setStep("source")}
                  className="px-3 py-2 text-sm border border-black/15 rounded-[6px] hover:bg-page"
                >
                  ← Back
                </button>
                <button
                  onClick={onImport}
                  disabled={busy || valid === 0}
                  className="crm-button crm-button-primary disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {busy ? "Importing…" : `Import ${valid} contact${valid === 1 ? "" : "s"}`}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Step 1: Source ─────────────────────────────────────────────────────

function SourceStep({
  fileRef, paste, setPaste, onFile, onPasteSubmit,
}: {
  fileRef: React.RefObject<HTMLInputElement>;
  paste: string;
  setPaste: (s: string) => void;
  onFile: (f: File) => void;
  onPasteSubmit: () => void;
}) {
  const [tab, setTab] = useState<"upload" | "paste">("upload");
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1 border-b border-black/10">
        <TabBtn active={tab === "upload"} onClick={() => setTab("upload")}>Upload file</TabBtn>
        <TabBtn active={tab === "paste"}  onClick={() => setTab("paste")}>Paste table</TabBtn>
      </div>

      {tab === "upload" && (
        <UploadDropzone fileRef={fileRef} onFile={onFile} />
      )}

      {tab === "paste" && (
        <div>
          <textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder={`Paste from Google Sheets, Excel, Notion, Airtable…\n\nName\tEmail\tCompany\nDanish Khan\tdanish@example.com\tAri`}
            className="w-full h-48 px-3 py-2.5 border border-black/15 rounded-[6px] text-[13px] font-mono outline-none focus:border-black/40 resize-y"
          />
          <div className="mt-3 flex items-center justify-between">
            <div className="text-[12px] text-txt-muted">
              Copy any table — header row first, one contact per row.
            </div>
            <button
              onClick={onPasteSubmit}
              disabled={!paste.trim()}
              className="dash-btn dash-btn-primary disabled:opacity-40"
            >
              Continue →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Drag-and-drop dropzone for the upload tab. Supports:
//   - click to open the OS file picker (label wraps the hidden input)
//   - drag CSV file from desktop / file manager → release inside the box
// We accept .csv / .tsv / .txt by extension OR by MIME type. If the
// user drops something that isn't text, we still try — parseCsv() will
// reject it and the modal will surface a friendly error.
function UploadDropzone({
  fileRef, onFile,
}: { fileRef: React.RefObject<HTMLInputElement>; onFile: (f: File) => void }) {
  const [over, setOver] = useState(false);

  function looksLikeCsv(file: File): boolean {
    const name = file.name.toLowerCase();
    if (/\.(csv|tsv|txt)$/.test(name)) return true;
    const t = (file.type || "").toLowerCase();
    return t.includes("csv") || t.includes("tab-separated") || t === "text/plain";
  }

  return (
    <div
      onDragOver={(e) => {
        // preventDefault is required to allow a drop; without it the
        // browser opens the file in a new tab instead of firing onDrop.
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length === 0) return;
        // Pick the first file that smells like a spreadsheet/CSV; fall
        // back to the first file so the user gets feedback either way.
        const pick = files.find(looksLikeCsv) || files[0];
        onFile(pick);
      }}
    >
      <label
        htmlFor="csv-upload-input"
        className={`flex flex-col items-center justify-center gap-2 py-12 border-2 border-dashed rounded-[8px] cursor-pointer transition-colors ${
          over
            ? "border-[#0a0a0a] bg-[#D8CCFF]/40"
            : "border-black/20 bg-page/40 hover:bg-page hover:border-black/30"
        }`}
      >
        <UploadIcon />
        <div className="text-[15px] font-semibold">
          {over ? "Drop to upload" : "Drop a CSV here, or click to browse"}
        </div>
        <div className="text-[13px] text-txt-muted text-center px-4">
          Works with exports from Gmail, LinkedIn, Apollo, HubSpot, Salesforce, Notion, Airtable, Excel, Sheets…
        </div>
        <input
          id="csv-upload-input"
          ref={fileRef}
          type="file"
          accept=".csv,text/csv,.tsv,text/tab-separated-values,.txt"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
        />
      </label>
    </div>
  );
}

// ─── Step 2: Map ────────────────────────────────────────────────────────

function MapStep({
  headers, rows, mapping, setField, valid, total, analysis,
  customFields, addCustomField, removeCustomField,
}: {
  headers: string[];
  rows: CsvRow[];
  mapping: ColumnMapping;
  setField: (h: string, f: FieldKey) => void;
  valid: number;
  total: number;
  analysis: {
    noName: number;
    byContact: { withEmail: number; withPhoneOnly: number; nameOnly: number };
  };
  customFields: string[];
  addCustomField: (label: string) => void;
  removeCustomField: (label: string) => void;
}) {
  const previewRows = rows.slice(0, 3);
  const [customDraft, setCustomDraft] = useState("");

  function commitCustom() {
    const label = customDraft.trim().slice(0, 40);
    if (!label) return;
    if (label.toLowerCase() === "ignore" || ["name","email","phone","company"].includes(label.toLowerCase())) return;
    addCustomField(label);
    setCustomDraft("");
  }

  return (
    <div className="space-y-4">
      <p className="text-[14px] text-txt-muted">
        We auto-detected the columns below. Override any of them if the match isn&apos;t right.
        Map a column to <span className="font-mono text-[12px] bg-page px-1 rounded">First name</span> or{" "}
        <span className="font-mono text-[12px] bg-page px-1 rounded">Last name</span> when the CSV has them split — we&apos;ll join them automatically.
      </p>
      <div className="overflow-x-auto -mx-1">
        <table className="w-full text-[13px] border-separate border-spacing-0">
          <thead>
            <tr>
              {headers.map(h => (
                <th key={h} className="px-2 pt-1 pb-2 align-top text-left">
                  <div className="text-[11px] uppercase tracking-wider text-txt-muted truncate" title={h}>{h}</div>
                  <FieldSelect
                    value={mapping[h] ?? "ignore"}
                    onChange={(f) => setField(h, f)}
                    customFields={customFields}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {previewRows.map((row, i) => (
              <tr key={i} className="border-t border-black/10">
                {headers.map(h => (
                  <td key={h} className="px-2 py-2 border-t border-black/10 text-[12px] text-txt-muted truncate max-w-[160px]" title={row[h]}>
                    {row[h] || <span className="text-black/20">empty</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Custom-fields manager */}
      <div className="border-t border-black/10 pt-4">
        <div className="text-[11px] uppercase tracking-wider font-bold text-txt-muted mb-2">Custom fields</div>
        <div className="flex flex-wrap items-center gap-2">
          {customFields.map(label => (
            <span key={label} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-card-lemon/40 border border-black/15 rounded-[5px] text-[12px] font-medium">
              {label}
              <button
                onClick={() => removeCustomField(label)}
                aria-label={`Remove ${label}`}
                className="text-txt-muted hover:text-black"
              >×</button>
            </span>
          ))}
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={customDraft}
              onChange={(e) => setCustomDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitCustom(); } }}
              placeholder={customFields.length === 0 ? "e.g. Job Title, LinkedIn URL, Industry" : "Add another"}
              className="px-2.5 py-1.5 text-[12px] border border-black/15 rounded-[5px] outline-none focus:border-black/40 w-[200px]"
            />
            <button
              onClick={commitCustom}
              disabled={!customDraft.trim()}
              className="px-2.5 py-1.5 text-[12px] font-medium border border-black/20 rounded-[5px] hover:bg-page disabled:opacity-40"
            >
              + Add field
            </button>
          </div>
        </div>
        <div className="text-[11px] text-txt-muted mt-2">
          Add a custom field, then map any column above to it. Stored on the lead so you can see it later.
        </div>
      </div>

      <div className="flex items-start justify-between text-[13px] pt-2 gap-4 flex-wrap">
        <div className="text-txt-muted min-w-0 flex-1">
          {total} row{total === 1 ? "" : "s"} parsed. Every row with a <b>name</b> imports — email and phone are optional now.
          <ul className="mt-2 space-y-1 text-[12px] text-txt-muted">
            {analysis.byContact.withEmail > 0 && (
              <li>• <span className="font-mono">{analysis.byContact.withEmail}</span> have email — fully reachable for outreach</li>
            )}
            {analysis.byContact.withPhoneOnly > 0 && (
              <li>• <span className="font-mono">{analysis.byContact.withPhoneOnly}</span> have phone only — go to the address book</li>
            )}
            {analysis.byContact.nameOnly > 0 && (
              <li>• <span className="font-mono">{analysis.byContact.nameOnly}</span> have only a name (+ company / LinkedIn / etc.) — saved as leads with no email; you can fill it in later</li>
            )}
            {analysis.noName > 0 && (
              <li>• <span className="font-mono">{analysis.noName}</span> have no name — skipped (likely blank or footer rows)</li>
            )}
          </ul>
        </div>
        <div className={`font-semibold whitespace-nowrap ${valid === 0 ? "text-red-700" : valid < total ? "text-black" : "text-green-700"}`}>
          {valid} ready{analysis.noName > 0 ? ` · ${analysis.noName} skipped` : ""}
        </div>
      </div>
    </div>
  );
}

function FieldSelect({
  value, onChange, customFields,
}: { value: FieldKey; onChange: (f: FieldKey) => void; customFields: string[] }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as FieldKey)}
      className={`mt-1 w-full px-2 py-1.5 text-[12px] font-medium rounded-[5px] border outline-none ${
        value === "ignore"
          ? "border-black/15 bg-page text-txt-muted"
          : "border-black/30 bg-white text-black"
      }`}
    >
      <option value="ignore">— Ignore</option>
      <optgroup label="Name">
        <option value="name">Full name</option>
        <option value="first_name">First name</option>
        <option value="last_name">Last name</option>
      </optgroup>
      <optgroup label="Contact">
        <option value="email">Email</option>
        <option value="phone">Phone</option>
      </optgroup>
      <optgroup label="Work">
        <option value="company">Company name</option>
        <option value="title">Job title</option>
        <option value="linkedin">LinkedIn URL</option>
        <option value="website">Website</option>
      </optgroup>
      {customFields.length > 0 && (
        <optgroup label="Custom fields">
          {customFields.map(label => (
            <option key={label} value={asCustom(label)}>{label}</option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

// ─── Step 3: Result ─────────────────────────────────────────────────────

function ResultStep({ result, onClose }: { result: ImportResult; onClose: () => void }) {
  const total = result.imported + result.matchedExisting;
  return (
    <div className="py-6 text-center space-y-3">
      <div className="text-4xl">✓</div>
      <div className="text-[18px] font-bold">
        {total} contact{total === 1 ? "" : "s"} processed
      </div>
      <ul className="text-[14px] text-txt-muted space-y-1 inline-block text-left">
        {result.imported > 0 && (
          <li>• <span className="font-mono">{result.imported}</span> newly imported</li>
        )}
        {result.matchedExisting > 0 && (
          <li>• <span className="font-mono">{result.matchedExisting}</span> already existed — fields merged</li>
        )}
        {result.mergedDuplicates > 0 && (
          <li>• <span className="font-mono">{result.mergedDuplicates}</span> shared an email/phone with another row in the CSV — kept as separate leads with no contact info</li>
        )}
        {result.addedToGroup > 0 && (
          <li>• <span className="font-mono">{result.addedToGroup}</span> added to this group</li>
        )}
        {result.skipped > 0 && (
          <li>• <span className="font-mono">{result.skipped}</span> skipped (no name)</li>
        )}
      </ul>
      <div>
        <button
          onClick={onClose}
          className="dash-btn dash-btn-primary mt-4"
        >
          Done
        </button>
      </div>
    </div>
  );
}

// ─── Bits ───────────────────────────────────────────────────────────────

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`relative px-3 py-2.5 text-[14px] font-semibold transition-colors ${
        active ? "text-black" : "text-txt-muted hover:text-black"
      }`}
    >
      {children}
      {active && <span className="absolute -bottom-px left-2 right-2 h-[2px] bg-black" />}
    </button>
  );
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-7 h-7 text-txt-muted">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
      <path d="M17 8l-5-5-5 5" />
      <path d="M12 3v12" />
    </svg>
  );
}
