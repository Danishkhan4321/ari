"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useEntityEvents } from "@/lib/use-entity-events";
import { CrmConfirm, CrmLoading, CrmPagination, CrmState, CrmToast } from "@/components/crm-page";

type Group = { id: number; name: string; emoji: string | null; member_count: number; created_at: string; archived_at: string | null };
const PAGE_SIZE = 8;

export function GroupsList() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"active" | "empty" | "archived" | "all">("active");
  const [sort, setSort] = useState("newest");
  const [page, setPage] = useState(1);
  const [editor, setEditor] = useState<Group | "new" | null>(null);
  const [confirm, setConfirm] = useState<{ group: Group; action: "archive" | "restore" | "delete" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const response = await fetch("/api/groups/list", { cache: "no-store" });
      const data = await response.json() as { groups?: Group[]; error?: string };
      if (!response.ok) throw new Error(data.error || "Could not load groups.");
      setGroups(data.groups || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load groups.");
      setGroups([]);
    }
  };

  useEffect(() => { void load(); }, []);
  // Refetch when the agent mutates groups/contacts while open (C-2).
  useEntityEvents(["groups", "contacts"], () => void load());
  useEffect(() => { setPage(1); }, [query, filter, sort]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 3500); return () => window.clearTimeout(timer); }, [toast]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return (groups || []).filter(group => {
      const matchesQuery = !term || group.name.toLowerCase().includes(term);
      const archived = Boolean(group.archived_at);
      const matchesFilter = filter === "all" || (filter === "active" && !archived) || (filter === "archived" && archived) || (filter === "empty" && !archived && Number(group.member_count) === 0);
      return matchesQuery && matchesFilter;
    }).sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : sort === "members" ? Number(b.member_count) - Number(a.member_count) : Number(b.id) - Number(a.id));
  }, [groups, query, filter, sort]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  async function runConfirmedAction() {
    if (!confirm) return;
    setBusy(true); setError(null);
    try {
      const response = confirm.action === "delete"
        ? await fetch(`/api/groups/${confirm.group.id}`, { method: "DELETE" })
        : await fetch(`/api/groups/${confirm.group.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: confirm.action === "archive" }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "The action could not be completed.");
      const action = confirm.action;
      setConfirm(null);
      await load();
      setToast(action === "delete" ? "Group deleted." : action === "archive" ? "Group archived." : "Group restored.");
    } catch (actionError) { setError(actionError instanceof Error ? actionError.message : "The action could not be completed."); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button className="crm-button crm-button-primary" onClick={() => setEditor("new")}><PlusIcon /> Create group</button>
        <span className="text-[10.5px] text-[#77736f]">{filtered.length} group{filtered.length === 1 ? "" : "s"}</span>
      </div>

      <section className="crm-panel">
        <div className="crm-panel-header">
          <div className="relative min-w-[220px] flex-1 sm:max-w-[360px]"><SearchIcon /><input className="crm-input pl-9" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search groups" aria-label="Search groups" /></div>
          <div className="flex flex-wrap gap-2">
            <select className="crm-select w-auto min-w-[125px]" value={filter} onChange={event => setFilter(event.target.value as typeof filter)} aria-label="Filter groups"><option value="active">Active groups</option><option value="empty">Empty groups</option><option value="archived">Archived</option><option value="all">All groups</option></select>
            <select className="crm-select w-auto min-w-[125px]" value={sort} onChange={event => setSort(event.target.value)} aria-label="Sort groups"><option value="newest">Newest first</option><option value="name">Name A–Z</option><option value="members">Most members</option></select>
          </div>
        </div>
        {error ? <div className="border-b border-[#e9caca] bg-[#fffafa] px-4 py-3 text-[11.5px] text-[#a32424]" role="alert">{error} <button className="ml-2 underline" onClick={() => void load()}>Try again</button></div> : null}
        {groups === null ? <CrmLoading rows={6} /> : rows.length === 0 ? <div className="p-4"><CrmState title={query || filter !== "active" ? "No groups match these filters" : "No groups yet"} description={query || filter !== "active" ? "Adjust the search or filter to see more audiences." : "Create a group, then add contacts and leads to build a campaign audience."} action={<button className="crm-button crm-button-primary" onClick={() => setEditor("new")}>Create group</button>} /></div> : (
          <div className="crm-table-wrap">
            <table className="crm-table">
              <thead><tr><th>Group</th><th>Members</th><th>Status</th><th>Created</th><th className="w-[190px] text-right">Actions</th></tr></thead>
              <tbody>{rows.map(group => (
                <tr key={group.id} className={group.archived_at ? "opacity-65" : ""}>
                  <td><div className="flex items-center gap-2.5"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-[8px] border border-[#e5dda3] bg-ari-nav text-[12px] font-semibold text-ari-ink">{group.emoji || group.name.slice(0, 1).toUpperCase()}</span><span><Link href={`/contacts/groups/${group.id}`} className="font-medium text-[#171717] hover:text-ari-ink hover:underline hover:decoration-[#dec51f]">{group.name}</Link><span className="block text-[10px] text-[#85807a]">Audience group</span></span></div></td>
                  <td><span className="num font-medium text-[#24211f]">{Number(group.member_count).toLocaleString()}</span><span className="ml-1 text-[10px] text-[#85807a]">people</span></td>
                  <td>{group.archived_at ? <span className="crm-status border-[#deddd8] bg-[#f4f3ef] text-[#77736f]">Archived</span> : Number(group.member_count) === 0 ? <span className="crm-status border-[#e7dcc0] bg-[#fffaf0] text-[#8a6419]">Empty</span> : <span className="crm-status border-[#c9ded2] bg-[#f2faf5] text-[#096645]"><span className="h-1 w-1 rounded-full bg-[#249469]" />Ready</span>}</td>
                  <td>{new Date(group.created_at).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })}</td>
                  <td><div className="flex justify-end gap-1.5"><Link className="crm-button min-h-8 px-2.5" href={`/contacts/groups/${group.id}`}>View</Link>{!group.archived_at && Number(group.member_count) > 0 ? <Link className="crm-icon-button" href={`/contacts/groups/${group.id}/email`} aria-label={`Email ${group.name}`} title="Create campaign"><MailIcon /></Link> : null}<button className="crm-icon-button" onClick={() => setEditor(group)} aria-label={`Edit ${group.name}`} title="Edit"><EditIcon /></button><button className="crm-icon-button" onClick={() => setConfirm({ group, action: group.archived_at ? "restore" : "archive" })} aria-label={`${group.archived_at ? "Restore" : "Archive"} ${group.name}`} title={group.archived_at ? "Restore" : "Archive"}><ArchiveIcon /></button><button className="crm-icon-button text-[#a32424] hover:text-[#a32424]" onClick={() => setConfirm({ group, action: "delete" })} aria-label={`Delete ${group.name}`} title="Delete"><TrashIcon /></button></div></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {groups !== null && filtered.length > 0 ? <CrmPagination page={Math.min(page, pageCount)} pageCount={pageCount} total={filtered.length} onPage={setPage} /> : null}
      </section>

      {editor ? <GroupEditor group={editor === "new" ? undefined : editor} onClose={() => setEditor(null)} onSaved={async message => { setEditor(null); await load(); setToast(message); }} /> : null}
      {confirm ? <CrmConfirm title={confirm.action === "delete" ? "Delete group?" : confirm.action === "archive" ? "Archive group?" : "Restore group?"} description={confirm.action === "delete" ? `${confirm.group.name} and its membership list will be permanently removed. Contacts themselves will not be deleted.` : confirm.action === "archive" ? `${confirm.group.name} will be hidden from active audiences and campaign creation.` : `${confirm.group.name} will be available for campaigns again.`} confirmLabel={confirm.action === "delete" ? "Delete group" : confirm.action === "archive" ? "Archive" : "Restore"} busy={busy} onConfirm={() => void runConfirmedAction()} onClose={() => !busy && setConfirm(null)} /> : null}
      {toast ? <CrmToast message={toast} onClose={() => setToast(null)} /> : null}
    </div>
  );
}

function GroupEditor({ group, onClose, onSaved }: { group?: Group; onClose: () => void; onSaved: (message: string) => void }) {
  const [name, setName] = useState(group?.name || "");
  const [emoji, setEmoji] = useState(group?.emoji || "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) { setError("Group name is required."); return; }
    setBusy(true); setError(null);
    try {
      const response = await fetch(group ? `/api/groups/${group.id}` : "/api/groups/list", { method: group ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name.trim(), emoji: emoji.trim() || null }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Could not save the group.");
      onSaved(group ? "Group updated successfully." : "Group created successfully.");
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "Could not save the group."); }
    finally { setBusy(false); }
  }
  return <div className="crm-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="group-editor-title" onMouseDown={onClose}><form className="crm-modal max-w-[460px]" onSubmit={save} onMouseDown={event => event.stopPropagation()}><div className="flex items-start justify-between border-b border-[#e5e3df] px-5 py-4"><div><h2 id="group-editor-title" className="text-[14px] font-semibold text-[#24211f]">{group ? "Edit group" : "Create group"}</h2><p className="mt-1 text-[10.5px] text-[#77736f]">Use a clear audience name your team will recognize.</p></div><button type="button" className="crm-icon-button border-0" onClick={onClose} aria-label="Close">×</button></div><div className="grid grid-cols-[72px_1fr] gap-4 px-5 py-5"><label><span className="crm-label">Icon</span><input className="crm-input text-center" value={emoji} onChange={event => setEmoji(event.target.value.slice(0, 2))} placeholder="A" aria-label="Group icon" /></label><label><span className="crm-label">Group name *</span><input className="crm-input" value={name} onChange={event => setName(event.target.value)} autoFocus maxLength={120} placeholder="e.g. Design partners" /></label>{error ? <div className="col-span-2 rounded-[5px] border border-[#e9caca] bg-[#fffafa] px-3 py-2 text-[11px] text-[#a32424]" role="alert">{error}</div> : null}</div><div className="flex justify-end gap-2 border-t border-[#e5e3df] bg-[#faf9f5] px-5 py-4"><button type="button" className="crm-button" onClick={onClose} disabled={busy}>Cancel</button><button className="crm-button crm-button-primary" disabled={busy}>{busy ? "Saving…" : group ? "Save changes" : "Create group"}</button></div></form></div>;
}

function SearchIcon() { return <svg className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#85807a]" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3"/><path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>; }
function PlusIcon() { return <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>; }
function MailIcon() { return <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2.5 4h11v8h-11z" stroke="currentColor" strokeWidth="1.2"/><path d="m3 4.7 5 4 5-4" stroke="currentColor" strokeWidth="1.2"/></svg>; }
function EditIcon() { return <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="m3 11.7-.4 1.7 1.7-.4 7.9-7.9-1.3-1.3L3 11.7Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>; }
function ArchiveIcon() { return <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2.5 4h11v9h-11zM2 2.5h12V5H2zM6 7.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>; }
function TrashIcon() { return <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3.5 4.5h9M6 4.5V3h4v1.5M5 6.5l.5 6h5l.5-6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
