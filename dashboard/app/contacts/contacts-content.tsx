"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useEntityEvents } from "@/lib/use-entity-events";
import { ImportCsvModal } from "@/components/import-csv-modal";
import { CrmConfirm, CrmLoading, CrmPagination, CrmState, CrmToast } from "@/components/crm-page";
import { STAGES, STAGE_LABELS, normalizeStage } from "@/lib/crm-shared";

type Lead = {
  id: number;
  name: string;
  email: string | null;
  company: string | null;
  title: string | null;
  stage: string | null;
  deal_value: number | null;
  source: string | null;
  notes: string | null;
  groups: string[];
  archived_at: string | null;
  created_at: string | null;
};

type LeadForm = {
  name: string;
  email: string;
  company: string;
  title: string;
  stage: string;
  deal_value: string;
  source: string;
  notes: string;
};

const EMPTY_FORM: LeadForm = { name: "", email: "", company: "", title: "", stage: "new", deal_value: "", source: "manual", notes: "" };
const PAGE_SIZE = 8;

export function ContactsContent() {
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState("all");
  const [visibility, setVisibility] = useState<"active" | "archived" | "all">("active");
  const [sort, setSort] = useState("newest");
  const [page, setPage] = useState(1);
  const [importOpen, setImportOpen] = useState(false);
  const [editor, setEditor] = useState<{ mode: "create" | "edit"; lead?: Lead } | null>(null);
  const [confirm, setConfirm] = useState<{ lead: Lead; action: "archive" | "restore" | "delete" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const response = await fetch("/api/contacts/list", { cache: "no-store" });
      const data = await response.json() as { ok?: boolean; leads?: Lead[]; error?: string };
      if (!response.ok) throw new Error(data.error || "Could not load contacts.");
      setLeads(data.leads || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load contacts.");
      setLeads([]);
    }
  };

  useEffect(() => { void load(); }, []);
  // Refetch when the agent mutates contacts/leads/groups while open (C-2).
  useEntityEvents(["contacts", "crm", "groups"], () => void load());
  useEffect(() => { setPage(1); }, [query, stage, visibility, sort]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    const rows = (leads || []).filter((lead) => {
      const matchesQuery = !term || [lead.name, lead.email, lead.company, lead.title, lead.source, ...(lead.groups || [])].some(value => String(value || "").toLowerCase().includes(term));
      const matchesStage = stage === "all" || normalizeStage(lead.stage) === stage;
      const archived = Boolean(lead.archived_at);
      const matchesVisibility = visibility === "all" || (visibility === "archived" ? archived : !archived);
      return matchesQuery && matchesStage && matchesVisibility;
    });
    return rows.sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "value") return Number(b.deal_value || 0) - Number(a.deal_value || 0);
      if (sort === "company") return String(a.company || "").localeCompare(String(b.company || ""));
      return Number(b.id) - Number(a.id);
    });
  }, [leads, query, stage, visibility, sort]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  async function runConfirmedAction() {
    if (!confirm) return;
    setBusy(true);
    try {
      const response = confirm.action === "delete"
        ? await fetch(`/api/contacts/${confirm.lead.id}`, { method: "DELETE" })
        : await fetch(`/api/contacts/${confirm.lead.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: confirm.action === "archive" }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "The action could not be completed.");
      setConfirm(null);
      await load();
      setToast(confirm.action === "delete" ? "Contact deleted." : confirm.action === "archive" ? "Contact archived." : "Contact restored.");
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "The action could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button className="crm-button crm-button-primary" onClick={() => setEditor({ mode: "create" })}><PlusIcon /> Add contact</button>
          <button className="crm-button" onClick={() => setImportOpen(true)}><UploadIcon /> Import CSV</button>
        </div>
        <div className="text-[10.5px] text-[#77736f]">{filtered.length} contact{filtered.length === 1 ? "" : "s"}</div>
      </div>

      <section className="crm-panel">
        <div className="crm-panel-header">
          <div className="relative min-w-[220px] flex-1 sm:max-w-[360px]">
            <SearchIcon />
            <input className="crm-input pl-9" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, company, email, or group" aria-label="Search contacts" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select className="crm-select w-auto min-w-[130px]" value={stage} onChange={(event) => setStage(event.target.value)} aria-label="Filter by stage">
              <option value="all">All stages</option>
              {STAGES.map(item => <option key={item} value={item}>{STAGE_LABELS[item]}</option>)}
            </select>
            <select className="crm-select w-auto min-w-[120px]" value={visibility} onChange={(event) => setVisibility(event.target.value as typeof visibility)} aria-label="Filter archived contacts">
              <option value="active">Active</option>
              <option value="archived">Archived</option>
              <option value="all">All records</option>
            </select>
            <select className="crm-select w-auto min-w-[125px]" value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort contacts">
              <option value="newest">Newest first</option>
              <option value="name">Name A–Z</option>
              <option value="company">Company A–Z</option>
              <option value="value">Highest value</option>
            </select>
          </div>
        </div>

        {error ? <div className="border-b border-[#e9caca] bg-[#fffafa] px-4 py-3 text-[11.5px] text-[#a32424]" role="alert">{error} <button className="ml-2 underline" onClick={() => void load()}>Try again</button></div> : null}
        {leads === null ? <CrmLoading rows={7} /> : rows.length === 0 ? (
          <div className="p-4">
            <CrmState title={query || stage !== "all" || visibility !== "active" ? "No contacts match these filters" : "No contacts yet"} description={query || stage !== "all" || visibility !== "active" ? "Clear or adjust the filters to see more records." : "Add your first contact manually or import a CSV file."} action={<button className="crm-button crm-button-primary" onClick={() => setEditor({ mode: "create" })}>Add contact</button>} />
          </div>
        ) : (
          <div className="crm-table-wrap">
            <table className="crm-table">
              <thead><tr><th>Contact</th><th>Company</th><th>Stage</th><th>Groups</th><th>Deal value</th><th className="w-[130px] text-right">Actions</th></tr></thead>
              <tbody>
                {rows.map(lead => (
                  <tr key={lead.id} className={lead.archived_at ? "opacity-65" : ""}>
                    <td>
                      <div className="flex items-center gap-2.5">
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#f4eedf] text-[10px] font-semibold text-[#0a0a0a]">{initials(lead.name)}</span>
                        <span className="min-w-0"><Link href={`/contacts/${lead.id}`} className="block truncate font-medium text-[#171717] hover:text-ari-ink hover:underline hover:decoration-[#dec51f]">{lead.name}</Link><span className="block truncate text-[10px] text-[#85807a]">{lead.email || "No email"}</span></span>
                      </div>
                    </td>
                    <td><span className="font-medium text-[#3c3834]">{lead.company || "—"}</span><span className="block text-[10px] text-[#85807a]">{lead.title || lead.source || ""}</span></td>
                    <td><StageBadge stage={lead.stage} archived={Boolean(lead.archived_at)} /></td>
                    <td><div className="flex max-w-[180px] flex-wrap gap-1">{lead.groups?.length ? lead.groups.slice(0, 2).map(group => <span key={group} className="rounded-[3px] bg-[#f3f1eb] px-1.5 py-0.5 text-[9.5px] text-[#625d58]">{group}</span>) : <span className="text-[#aaa6a0]">—</span>}</div></td>
                    <td className="num">{lead.deal_value ? formatCurrency(lead.deal_value) : "—"}</td>
                    <td>
                      <div className="flex justify-end gap-1.5">
                        <Link href={`/contacts/${lead.id}`} className="crm-icon-button" aria-label={`View ${lead.name}`} title="View"><EyeIcon /></Link>
                        <button className="crm-icon-button" onClick={() => setEditor({ mode: "edit", lead })} aria-label={`Edit ${lead.name}`} title="Edit"><EditIcon /></button>
                        <button className="crm-icon-button" onClick={() => setConfirm({ lead, action: lead.archived_at ? "restore" : "archive" })} aria-label={`${lead.archived_at ? "Restore" : "Archive"} ${lead.name}`} title={lead.archived_at ? "Restore" : "Archive"}><ArchiveIcon /></button>
                        <button className="crm-icon-button text-[#a32424] hover:text-[#a32424]" onClick={() => setConfirm({ lead, action: "delete" })} aria-label={`Delete ${lead.name}`} title="Delete"><TrashIcon /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {leads !== null && filtered.length > 0 ? <CrmPagination page={Math.min(page, pageCount)} pageCount={pageCount} total={filtered.length} onPage={setPage} /> : null}
      </section>

      {editor ? <ContactEditor mode={editor.mode} lead={editor.lead} onClose={() => setEditor(null)} onSaved={async message => { setEditor(null); await load(); setToast(message); }} /> : null}
      {confirm ? <CrmConfirm title={confirm.action === "delete" ? "Delete contact?" : confirm.action === "archive" ? "Archive contact?" : "Restore contact?"} description={confirm.action === "delete" ? `${confirm.lead.name} will be permanently removed from CRM and every group. This cannot be undone.` : confirm.action === "archive" ? `${confirm.lead.name} will move out of the active contact list. You can restore the record later.` : `${confirm.lead.name} will return to the active contact list.`} confirmLabel={confirm.action === "delete" ? "Delete permanently" : confirm.action === "archive" ? "Archive" : "Restore"} busy={busy} onConfirm={() => void runConfirmedAction()} onClose={() => !busy && setConfirm(null)} /> : null}
      <ImportCsvModal open={importOpen} onClose={() => setImportOpen(false)} onImported={() => { setImportOpen(false); void load(); setToast("Contacts imported successfully."); }} />
      {toast ? <CrmToast message={toast} onClose={() => setToast(null)} /> : null}
    </div>
  );
}

function ContactEditor({ mode, lead, onClose, onSaved }: { mode: "create" | "edit"; lead?: Lead; onClose: () => void; onSaved: (message: string) => void }) {
  const [form, setForm] = useState<LeadForm>(lead ? { name: lead.name || "", email: lead.email || "", company: lead.company || "", title: lead.title || "", stage: normalizeStage(lead.stage), deal_value: lead.deal_value ? String(lead.deal_value) : "", source: lead.source || "", notes: lead.notes || "" } : EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const update = (key: keyof LeadForm, value: string) => setForm(current => ({ ...current, [key]: value }));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    if (form.name.trim().length < 2) nextErrors.name = "Enter at least 2 characters.";
    if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) nextErrors.email = "Enter a valid email address.";
    if (form.deal_value && (!Number.isFinite(Number(form.deal_value)) || Number(form.deal_value) < 0)) nextErrors.deal_value = "Enter a valid positive amount.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    setBusy(true); setSubmitError(null);
    try {
      const payload = { ...form, name: form.name.trim(), email: form.email.trim() || null, deal_value: form.deal_value ? Number(form.deal_value) : null };
      const response = await fetch(mode === "create" ? "/api/contacts/create" : `/api/contacts/${lead!.id}`, { method: mode === "create" ? "POST" : "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json() as { ok?: boolean; id?: number; error?: string };
      if (!response.ok) throw new Error(data.error || "Could not save the contact.");
      const id = mode === "create" ? Number(data.id) : lead!.id;
      if (id && form.stage !== normalizeStage(lead?.stage || "new")) {
        const stageResponse = await fetch("/api/contacts/stage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, stage: form.stage }) });
        if (!stageResponse.ok) throw new Error("The contact was saved, but its stage could not be updated.");
      }
      onSaved(mode === "create" ? "Contact created successfully." : "Contact updated successfully.");
    } catch (saveError) {
      setSubmitError(saveError instanceof Error ? saveError.message : "Could not save the contact.");
    } finally { setBusy(false); }
  }

  return (
    <div className="crm-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="contact-editor-title" onMouseDown={onClose}>
      <form className="crm-modal" onSubmit={save} onMouseDown={event => event.stopPropagation()} noValidate>
        <div className="flex items-start justify-between border-b border-[#e5e3df] px-5 py-4"><div><h2 id="contact-editor-title" className="text-[14px] font-semibold text-[#24211f]">{mode === "create" ? "Add contact" : "Edit contact"}</h2><p className="mt-1 text-[10.5px] text-[#77736f]">Fields marked required must be completed.</p></div><button type="button" className="crm-icon-button border-0" onClick={onClose} aria-label="Close">×</button></div>
        <div className="grid gap-4 px-5 py-5 sm:grid-cols-2">
          <Field label="Full name" required error={errors.name}><input className="crm-input" value={form.name} onChange={event => update("name", event.target.value)} placeholder="e.g. Ishita Rathore" autoFocus /></Field>
          <Field label="Email" error={errors.email}><input className="crm-input" type="email" value={form.email} onChange={event => update("email", event.target.value)} placeholder="name@company.com" /></Field>
          <Field label="Company"><input className="crm-input" value={form.company} onChange={event => update("company", event.target.value)} placeholder="Company name" /></Field>
          <Field label="Job title"><input className="crm-input" value={form.title} onChange={event => update("title", event.target.value)} placeholder="Role or title" /></Field>
          <Field label="Stage"><select className="crm-select" value={form.stage} onChange={event => update("stage", event.target.value)}>{STAGES.map(item => <option key={item} value={item}>{STAGE_LABELS[item]}</option>)}</select></Field>
          <Field label="Deal value" error={errors.deal_value}><input className="crm-input" type="number" min="0" value={form.deal_value} onChange={event => update("deal_value", event.target.value)} placeholder="0" /></Field>
          <Field label="Source"><input className="crm-input" value={form.source} onChange={event => update("source", event.target.value)} placeholder="Referral, inbound, event…" /></Field>
          <div className="sm:col-span-2"><Field label="Notes"><textarea className="crm-textarea" value={form.notes} onChange={event => update("notes", event.target.value)} placeholder="Add useful context, preferences, or next steps." /></Field></div>
          {submitError ? <div className="sm:col-span-2 rounded-[5px] border border-[#e9caca] bg-[#fffafa] px-3 py-2 text-[11px] text-[#a32424]" role="alert">{submitError}</div> : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-[#e5e3df] bg-[#faf9f5] px-5 py-4"><button type="button" className="crm-button" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="crm-button crm-button-primary" disabled={busy}>{busy ? "Saving…" : mode === "create" ? "Add contact" : "Save changes"}</button></div>
      </form>
    </div>
  );
}

function Field({ label, required, error, children }: { label: string; required?: boolean; error?: string; children: React.ReactNode }) { return <label className="block"><span className="crm-label">{label}{required ? " *" : ""}</span>{children}{error ? <span className="mt-1 block text-[10px] text-[#a32424]">{error}</span> : null}</label>; }
function StageBadge({ stage, archived }: { stage: string | null; archived: boolean }) { const value = normalizeStage(stage); return archived ? <span className="crm-status border-[#deddd8] bg-[#f4f3ef] text-[#77736f]">Archived</span> : <span className="crm-status border-[#c9ded2] bg-[#f2faf5] text-[#096645]"><span className="h-1 w-1 rounded-full bg-[#249469]" />{STAGE_LABELS[value]}</span>; }
function initials(name: string) { return name.split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase(); }
function formatCurrency(value: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value); }

function SearchIcon() { return <svg className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#85807a]" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3"/><path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>; }
function PlusIcon() { return <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>; }
function UploadIcon() { return <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 10V2.5m0 0L5 5.5m3-3 3 3M3 9.5v3.5h10V9.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function EyeIcon() { return <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1.8 8s2.1-3.5 6.2-3.5S14.2 8 14.2 8 12.1 11.5 8 11.5 1.8 8 1.8 8Z" stroke="currentColor" strokeWidth="1.2"/><circle cx="8" cy="8" r="1.7" stroke="currentColor" strokeWidth="1.2"/></svg>; }
function EditIcon() { return <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="m3 11.7-.4 1.7 1.7-.4 7.9-7.9-1.3-1.3L3 11.7Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>; }
function ArchiveIcon() { return <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2.5 4h11v9h-11zM2 2.5h12V5H2zM6 7.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>; }
function TrashIcon() { return <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3.5 4.5h9M6 4.5V3h4v1.5M5 6.5l.5 6h5l.5-6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
