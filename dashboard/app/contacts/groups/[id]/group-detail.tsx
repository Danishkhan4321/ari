"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AddMemberModal } from "@/components/add-member-modal";
import { CrmConfirm, CrmLoading, CrmPagination, CrmState, CrmToast } from "@/components/crm-page";

type Group = { id: number; name: string; emoji: string | null; member_count: number; created_at: string; archived_at: string | null };
type Member = { member_kind: "lead" | "contact"; member_id: number; name: string; email: string | null; phone: string | null; company: string | null; title: string | null; last_contacted_at: string | null };
type Detail = { group: Group; members: Member[] };
const PAGE_SIZE = 8;

export function GroupDetail({ id }: { id: number }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "sendable" | "missing_email">("all");
  const [sort, setSort] = useState("name");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ action: "remove" | "delete"; members?: Member[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const response = await fetch(`/api/groups/${id}`, { cache: "no-store" });
      const data = await response.json() as { ok?: boolean; group?: Group; members?: Member[]; error?: string };
      if (!response.ok || !data.group) throw new Error(data.error || "Could not load this group.");
      setDetail({ group: data.group, members: data.members || [] });
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "Could not load this group."); }
  };

  useEffect(() => { void load(); }, [id]);
  useEffect(() => { setPage(1); }, [query, filter, sort]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 3500); return () => window.clearTimeout(timer); }, [toast]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return (detail?.members || []).filter(member => {
      const matchesQuery = !term || [member.name, member.email, member.phone, member.company, member.title].some(value => String(value || "").toLowerCase().includes(term));
      const matchesFilter = filter === "all" || (filter === "sendable" ? Boolean(member.email) : !member.email);
      return matchesQuery && matchesFilter;
    }).sort((a, b) => sort === "recent" ? String(b.last_contacted_at || "").localeCompare(String(a.last_contacted_at || "")) : sort === "company" ? String(a.company || "").localeCompare(String(b.company || "")) : a.name.localeCompare(b.name));
  }, [detail, query, filter, sort]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const sendable = detail?.members.filter(member => member.email).length || 0;

  async function removeMembers() {
    const members = confirm?.members || [];
    if (!members.length) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/groups/${id}/members`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ members: members.map(member => ({ kind: member.member_kind, id: member.member_id })) }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Could not remove members.");
      setConfirm(null); setSelected(new Set()); await load(); setToast(`${members.length} member${members.length === 1 ? "" : "s"} removed.`);
    } catch (removeError) { setError(removeError instanceof Error ? removeError.message : "Could not remove members."); }
    finally { setBusy(false); }
  }

  async function deleteGroup() {
    setBusy(true);
    try {
      const response = await fetch(`/api/groups/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not delete the group.");
      window.location.href = "/contacts/groups";
    } catch (deleteError) { setError(deleteError instanceof Error ? deleteError.message : "Could not delete the group."); setBusy(false); }
  }

  if (!detail && !error) return <div className="crm-page"><div className="crm-page-inner"><CrmLoading rows={8} /></div></div>;
  if (!detail) return <div className="crm-page"><div className="crm-page-inner"><CrmState tone="error" title="Group unavailable" description={error || "This group could not be loaded."} action={<Link href="/contacts/groups" className="crm-button">Back to groups</Link>} /></div></div>;

  return (
    <div className="crm-page"><div className="crm-page-inner">
      <div className="crm-breadcrumb"><Link href="/contacts" className="hover:text-ari-ink">CRM</Link><span>/</span><Link href="/contacts/groups" className="hover:text-ari-ink">Manage groups</Link><span>/</span><span className="font-medium text-[#24211f]">Detailed view</span></div>
      <Link href="/contacts/groups" className="mt-4 inline-flex items-center gap-2 text-[11.5px] text-[#3c3834] hover:text-ari-ink"><span className="crm-icon-button h-7 w-7">‹</span> Go back</Link>

      <section className="crm-panel mt-5">
        <div className="flex flex-wrap items-center justify-between gap-5 px-5 py-5 sm:px-6">
          <div className="flex min-w-0 items-center gap-3.5"><span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[#f4e6c6] text-[17px] font-semibold text-[#0a0a0a]">{detail.group.emoji || detail.group.name.slice(0, 1).toUpperCase()}</span><div><h1 className="text-[20px] font-semibold tracking-[-0.035em] text-[#171717]">{detail.group.name}</h1><p className="mt-1 text-[10.5px] text-[#77736f]">{detail.members.length} people · {sendable} with email</p></div></div>
          <div className="flex flex-wrap items-center gap-2"><button className="crm-button" onClick={() => setEditOpen(true)}>Edit group</button><button className="crm-button" onClick={() => setAddOpen(true)}>Add people</button><Link className={`crm-button crm-button-primary ${sendable === 0 ? "pointer-events-none opacity-45" : ""}`} href={`/contacts/groups/${id}/email`}>Create campaign</Link><button className="crm-icon-button text-[#a32424] hover:text-[#a32424]" onClick={() => setConfirm({ action: "delete" })} aria-label="Delete group" title="Delete group"><TrashIcon /></button></div>
        </div>
        <div className="grid border-t border-[#e5e3df] sm:grid-cols-3"><Stat label="Total members" value={detail.members.length} /><Stat label="Email-ready" value={sendable} /><Stat label="Coverage" value={`${detail.members.length ? Math.round(sendable / detail.members.length * 100) : 0}%`} last /></div>
      </section>

      <section className="crm-panel mt-5">
        <div className="crm-panel-header"><div><h2 className="crm-section-title">Group members</h2><p className="mt-1 text-[10.5px] text-[#77736f]">Add, find, or remove people from this audience.</p></div>{selected.size ? <button className="crm-button crm-button-danger" onClick={() => setConfirm({ action: "remove", members: detail.members.filter(member => selected.has(keyOf(member))) })}>Remove {selected.size} selected</button> : null}</div>
        <div className="flex flex-wrap items-center gap-2 border-b border-[#e5e3df] px-4 py-3"><div className="relative min-w-[220px] flex-1 sm:max-w-[360px]"><SearchIcon /><input className="crm-input pl-9" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search group members" type="search" /></div><select className="crm-select w-auto min-w-[135px]" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="all">All members</option><option value="sendable">Has email</option><option value="missing_email">Missing email</option></select><select className="crm-select w-auto min-w-[135px]" value={sort} onChange={event => setSort(event.target.value)}><option value="name">Name A–Z</option><option value="company">Company A–Z</option><option value="recent">Recently contacted</option></select></div>
        {error ? <div className="border-b border-[#e9caca] bg-[#fffafa] px-4 py-3 text-[11px] text-[#a32424]">{error}</div> : null}
        {rows.length === 0 ? <div className="p-4"><CrmState title={detail.members.length ? "No members match these filters" : "This group is empty"} description={detail.members.length ? "Adjust the search or email filter." : "Add existing contacts or create a new person for this group."} action={<button className="crm-button crm-button-primary" onClick={() => setAddOpen(true)}>Add people</button>} /></div> : <div className="crm-table-wrap"><table className="crm-table"><thead><tr><th className="w-10"><input type="checkbox" aria-label="Select visible members" checked={rows.length > 0 && rows.every(member => selected.has(keyOf(member)))} onChange={event => { const next = new Set(selected); rows.forEach(member => event.target.checked ? next.add(keyOf(member)) : next.delete(keyOf(member))); setSelected(next); }} /></th><th>Person</th><th>Company</th><th>Contact</th><th>Last contacted</th><th className="w-16 text-right">Action</th></tr></thead><tbody>{rows.map(member => <tr key={keyOf(member)}><td><input type="checkbox" aria-label={`Select ${member.name}`} checked={selected.has(keyOf(member))} onChange={event => { const next = new Set(selected); event.target.checked ? next.add(keyOf(member)) : next.delete(keyOf(member)); setSelected(next); }} /></td><td><div className="flex items-center gap-2.5"><span className="grid h-8 w-8 place-items-center rounded-full bg-[#f4eedf] text-[10px] font-semibold text-[#260805]">{initials(member.name)}</span><span><span className="block font-medium text-[#171717]">{member.name}</span><span className="text-[10px] text-[#85807a]">{member.member_kind === "lead" ? "CRM contact" : "Address book"}</span></span></div></td><td>{member.company || "—"}<span className="block text-[10px] text-[#85807a]">{member.title || ""}</span></td><td>{member.email || member.phone || <span className="text-[#a56f26]">Missing email</span>}</td><td>{member.last_contacted_at ? new Date(member.last_contacted_at).toLocaleDateString() : "Never"}</td><td><div className="flex justify-end"><button className="crm-icon-button text-[#a32424] hover:text-[#a32424]" onClick={() => setConfirm({ action: "remove", members: [member] })} aria-label={`Remove ${member.name}`} title="Remove from group">×</button></div></td></tr>)}</tbody></table></div>}
        {filtered.length ? <CrmPagination page={Math.min(page, pageCount)} pageCount={pageCount} total={filtered.length} onPage={setPage} /> : null}
      </section>

      <AddMemberModal open={addOpen} onClose={() => setAddOpen(false)} groupId={id} groupName={detail.group.name} existing={detail.members.map(member => ({ kind: member.member_kind, id: member.member_id }))} onAdded={() => { void load(); setToast("Member added to the group."); }} />
      {editOpen ? <EditGroup group={detail.group} onClose={() => setEditOpen(false)} onSaved={async () => { setEditOpen(false); await load(); setToast("Group updated."); }} /> : null}
      {confirm?.action === "remove" ? <CrmConfirm title="Remove from group?" description={`${confirm.members?.length || 0} selected member${confirm.members?.length === 1 ? "" : "s"} will be removed from ${detail.group.name}. Their contact records will remain in CRM.`} confirmLabel="Remove members" busy={busy} onConfirm={() => void removeMembers()} onClose={() => !busy && setConfirm(null)} /> : null}
      {confirm?.action === "delete" ? <CrmConfirm title="Delete group?" description={`${detail.group.name} and its membership list will be permanently removed. Contact records will remain in CRM.`} confirmLabel="Delete group" busy={busy} onConfirm={() => void deleteGroup()} onClose={() => !busy && setConfirm(null)} /> : null}
      {toast ? <CrmToast message={toast} onClose={() => setToast(null)} /> : null}
    </div></div>
  );
}

function EditGroup({ group, onClose, onSaved }: { group: Group; onClose: () => void; onSaved: () => void }) { const [name, setName] = useState(group.name); const [emoji, setEmoji] = useState(group.emoji || ""); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false); async function submit(event: React.FormEvent) { event.preventDefault(); if (!name.trim()) { setError("Group name is required."); return; } setBusy(true); const response = await fetch(`/api/groups/${group.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name.trim(), emoji: emoji || null }) }); const data = await response.json() as { error?: string }; setBusy(false); if (!response.ok) { setError(data.error || "Could not update the group."); return; } onSaved(); } return <div className="crm-modal-backdrop" role="dialog" aria-modal="true" onMouseDown={onClose}><form className="crm-modal max-w-[450px]" onSubmit={submit} onMouseDown={event => event.stopPropagation()}><div className="border-b border-[#e5e3df] px-5 py-4"><h2 className="text-[14px] font-semibold">Edit group</h2></div><div className="grid grid-cols-[72px_1fr] gap-4 px-5 py-5"><label><span className="crm-label">Icon</span><input className="crm-input text-center" value={emoji} onChange={event => setEmoji(event.target.value.slice(0, 2))} /></label><label><span className="crm-label">Name *</span><input className="crm-input" value={name} onChange={event => setName(event.target.value)} autoFocus /></label>{error ? <p className="col-span-2 text-[11px] text-[#a32424]">{error}</p> : null}</div><div className="flex justify-end gap-2 border-t border-[#e5e3df] bg-[#faf9f5] px-5 py-4"><button type="button" className="crm-button" onClick={onClose}>Cancel</button><button className="crm-button crm-button-primary" disabled={busy}>{busy ? "Saving…" : "Save changes"}</button></div></form></div>; }
function Stat({ label, value, last }: { label: string; value: string | number; last?: boolean }) { return <div className={`px-5 py-4 ${last ? "" : "border-b border-[#e5e3df] sm:border-b-0 sm:border-r"}`}><span className="block text-[9.5px] uppercase tracking-[0.07em] text-[#85807a]">{label}</span><span className="mt-1 block text-[17px] font-semibold tracking-[-0.03em] text-[#24211f]">{value}</span></div>; }
function keyOf(member: Member) { return `${member.member_kind}-${member.member_id}`; }
function initials(name: string) { return name.split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase(); }
function SearchIcon() { return <svg className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#85807a]" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3"/><path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>; }
function TrashIcon() { return <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3.5 4.5h9M6 4.5V3h4v1.5M5 6.5l.5 6h5l.5-6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
