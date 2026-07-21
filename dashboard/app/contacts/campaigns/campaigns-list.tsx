"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useEntityEvents } from "@/lib/use-entity-events";
import { CrmConfirm, CrmLoading, CrmPagination, CrmState, CrmToast } from "@/components/crm-page";

type Campaign = { id: number; group_id: number | null; subject: string; recipient_count: number; sent_count: number; failed_count: number; status: string; scheduled_for: string | null; created_at: string; completed_at: string | null; opened_count: number; clicked_count: number; daily_send_limit: number; archived_at: string | null };
type Group = { id: number; name: string; member_count: number; archived_at: string | null };
type Recipient = { id: number; recipient_email: string; send_status: string; opened_at: string | null; clicked_at: string | null };
type CampaignDetail = { campaign: Campaign & { body_template: string; group_name: string | null }; recipients: Recipient[] };
const PAGE_SIZE = 8;

export function CampaignsList() {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [visibility, setVisibility] = useState<"active" | "archived" | "all">("active");
  const [sort, setSort] = useState("newest");
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<CampaignDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [confirm, setConfirm] = useState<{ campaign: Campaign; action: "archive" | "restore" | "delete" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const [campaignResponse, groupResponse] = await Promise.all([fetch("/api/campaigns/list", { cache: "no-store" }), fetch("/api/groups/list", { cache: "no-store" })]);
      const campaignData = await campaignResponse.json() as { campaigns?: Campaign[]; error?: string };
      const groupData = await groupResponse.json() as { groups?: Group[] };
      if (!campaignResponse.ok) throw new Error(campaignData.error || "Could not load campaigns.");
      setCampaigns(campaignData.campaigns || []); setGroups(groupData.groups || []);
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "Could not load campaigns."); setCampaigns([]); }
  };
  useEffect(() => { void load(); }, []);
  // Refetch when the agent mutates campaigns/groups while open (C-2).
  useEntityEvents(["campaigns", "groups"], () => void load());
  useEffect(() => { setPage(1); }, [query, status, visibility, sort]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 3500); return () => window.clearTimeout(timer); }, [toast]);

  const groupName = useCallback((id: number | null) => groups.find(group => Number(group.id) === Number(id))?.name || "Deleted group", [groups]);
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return (campaigns || []).filter(campaign => {
      const matchesQuery = !term || campaign.subject.toLowerCase().includes(term) || groupName(campaign.group_id).toLowerCase().includes(term);
      const normalized = normalizeStatus(campaign.status);
      const matchesStatus = status === "all" || normalized === status;
      const archived = Boolean(campaign.archived_at);
      const matchesVisibility = visibility === "all" || (visibility === "archived" ? archived : !archived);
      return matchesQuery && matchesStatus && matchesVisibility;
    }).sort((a, b) => sort === "audience" ? Number(b.recipient_count) - Number(a.recipient_count) : sort === "performance" ? rate(b.opened_count, b.sent_count) - rate(a.opened_count, a.sent_count) : Number(b.id) - Number(a.id));
  }, [campaigns, groupName, query, status, visibility, sort]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  async function viewCampaign(campaign: Campaign) {
    setDetailLoading(true); setError(null);
    try { const response = await fetch(`/api/campaigns/${campaign.id}`, { cache: "no-store" }); const data = await response.json() as CampaignDetail & { error?: string }; if (!response.ok) throw new Error(data.error || "Could not load campaign details."); setSelected(data); }
    catch (viewError) { setError(viewError instanceof Error ? viewError.message : "Could not load campaign details."); }
    finally { setDetailLoading(false); }
  }

  async function setCampaignStatus(campaign: Campaign, action: "pause" | "resume") {
    setBusy(true); setError(null);
    try { const response = await fetch(`/api/campaigns/${campaign.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) }); const data = await response.json() as { error?: string }; if (!response.ok) throw new Error(data.error || "Could not update the campaign."); await load(); setToast(action === "pause" ? "Campaign paused." : "Campaign resumed."); }
    catch (actionError) { setError(actionError instanceof Error ? actionError.message : "Could not update the campaign."); }
    finally { setBusy(false); }
  }

  async function runConfirmedAction() {
    if (!confirm) return;
    setBusy(true); setError(null);
    try {
      const response = confirm.action === "delete" ? await fetch(`/api/campaigns/${confirm.campaign.id}`, { method: "DELETE" }) : await fetch(`/api/campaigns/${confirm.campaign.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: confirm.action === "archive" }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "The action could not be completed.");
      const action = confirm.action; setConfirm(null); await load(); setToast(action === "delete" ? "Campaign deleted." : action === "archive" ? "Campaign archived." : "Campaign restored.");
    } catch (actionError) { setError(actionError instanceof Error ? actionError.message : "The action could not be completed."); }
    finally { setBusy(false); }
  }

  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><button className="crm-button crm-button-primary" onClick={() => setCreateOpen(true)}><PlusIcon /> New campaign</button><span className="text-[10.5px] text-[#77736f]">{filtered.length} campaign{filtered.length === 1 ? "" : "s"}</span></div>
    <section className="crm-panel">
      <div className="crm-panel-header"><div className="relative min-w-[220px] flex-1 sm:max-w-[340px]"><SearchIcon /><input className="crm-input pl-9" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search campaigns or groups" /></div><div className="flex flex-wrap gap-2"><select className="crm-select w-auto min-w-[125px]" value={status} onChange={event => setStatus(event.target.value)}><option value="all">All statuses</option><option value="draft">Draft</option><option value="active">Active</option><option value="paused">Paused</option><option value="completed">Completed</option><option value="failed">Failed</option></select><select className="crm-select w-auto min-w-[120px]" value={visibility} onChange={event => setVisibility(event.target.value as typeof visibility)}><option value="active">Current</option><option value="archived">Archived</option><option value="all">All records</option></select><select className="crm-select w-auto min-w-[130px]" value={sort} onChange={event => setSort(event.target.value)}><option value="newest">Newest first</option><option value="audience">Largest audience</option><option value="performance">Highest open rate</option></select></div></div>
      {error ? <div className="border-b border-[#e9caca] bg-[#fffafa] px-4 py-3 text-[11.5px] text-[#a32424]" role="alert">{error} <button className="ml-2 underline" onClick={() => void load()}>Try again</button></div> : null}
      {campaigns === null ? <CrmLoading rows={7} /> : rows.length === 0 ? <div className="p-4"><CrmState title={query || status !== "all" || visibility !== "active" ? "No campaigns match these filters" : "No campaigns yet"} description={query || status !== "all" || visibility !== "active" ? "Adjust the search or status filter." : "Select a group, write an email, and set a daily sending limit."} action={<button className="crm-button crm-button-primary" onClick={() => setCreateOpen(true)}>New campaign</button>} /></div> : <div className="crm-table-wrap"><table className="crm-table"><thead><tr><th>Campaign</th><th>Audience</th><th>Progress</th><th>Performance</th><th>Status</th><th className="w-[190px] text-right">Actions</th></tr></thead><tbody>{rows.map(campaign => { const normalized = normalizeStatus(campaign.status); const progress = rate(campaign.sent_count + campaign.failed_count, campaign.recipient_count); return <tr key={campaign.id} className={campaign.archived_at ? "opacity-65" : ""}><td><button className="text-left" onClick={() => void viewCampaign(campaign)}><span className="block font-medium text-[#171717] hover:text-[#096645] hover:underline">{campaign.subject}</span><span className="mt-0.5 block text-[10px] text-[#85807a]">{groupName(campaign.group_id)} · {new Date(campaign.created_at).toLocaleDateString()}</span></button></td><td><span className="num font-medium text-[#24211f]">{Number(campaign.recipient_count).toLocaleString()}</span><span className="block text-[10px] text-[#85807a]">{campaign.daily_send_limit || campaign.recipient_count}/day · {Math.max(1, Math.ceil(campaign.recipient_count / Math.max(1, campaign.daily_send_limit || campaign.recipient_count)))} days</span></td><td><div className="w-[130px]"><div className="mb-1 flex justify-between text-[9.5px] text-[#77736f]"><span>{campaign.sent_count} sent</span><span>{progress}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-[#eeece7]"><div className="h-full rounded-full bg-[#249469]" style={{ width: `${progress}%` }} /></div></div></td><td><span className="font-medium text-[#24211f]">{rate(campaign.opened_count, campaign.sent_count)}% open</span><span className="block text-[10px] text-[#85807a]">{rate(campaign.clicked_count, campaign.sent_count)}% clicked</span></td><td><StatusBadge status={normalized} archived={Boolean(campaign.archived_at)} /></td><td><div className="flex justify-end gap-1.5"><button className="crm-button min-h-8 px-2.5" onClick={() => void viewCampaign(campaign)} disabled={detailLoading}>View</button>{normalized === "active" ? <button className="crm-icon-button" onClick={() => void setCampaignStatus(campaign, "pause")} title="Pause" aria-label={`Pause ${campaign.subject}`}><PauseIcon /></button> : normalized === "paused" ? <button className="crm-icon-button" onClick={() => void setCampaignStatus(campaign, "resume")} title="Resume" aria-label={`Resume ${campaign.subject}`}><PlayIcon /></button> : null}<button className="crm-icon-button" onClick={() => setConfirm({ campaign, action: campaign.archived_at ? "restore" : "archive" })} title={campaign.archived_at ? "Restore" : "Archive"}><ArchiveIcon /></button><button className="crm-icon-button text-[#a32424] hover:text-[#a32424]" onClick={() => setConfirm({ campaign, action: "delete" })} title="Delete" disabled={normalized === "active"}><TrashIcon /></button></div></td></tr>; })}</tbody></table></div>}
      {campaigns !== null && filtered.length ? <CrmPagination page={Math.min(page, pageCount)} pageCount={pageCount} total={filtered.length} onPage={setPage} /> : null}
    </section>
    {createOpen ? <NewCampaign groups={groups.filter(group => !group.archived_at)} onClose={() => setCreateOpen(false)} onContinue={(groupId, limit) => router.push(`/contacts/groups/${groupId}/email?dailyLimit=${limit}`)} /> : null}
    {selected ? <CampaignPanel detail={selected} onClose={() => setSelected(null)} /> : null}
    {confirm ? <CrmConfirm title={confirm.action === "delete" ? "Delete campaign?" : confirm.action === "archive" ? "Archive campaign?" : "Restore campaign?"} description={confirm.action === "delete" ? `${confirm.campaign.subject} and its recipient activity will be permanently removed.` : confirm.action === "archive" ? `${confirm.campaign.subject} will move out of the current campaign list.` : `${confirm.campaign.subject} will return to the current campaign list.`} confirmLabel={confirm.action === "delete" ? "Delete campaign" : confirm.action === "archive" ? "Archive" : "Restore"} busy={busy} onConfirm={() => void runConfirmedAction()} onClose={() => !busy && setConfirm(null)} /> : null}
    {toast ? <CrmToast message={toast} onClose={() => setToast(null)} /> : null}
  </div>;
}

function NewCampaign({ groups, onClose, onContinue }: { groups: Group[]; onClose: () => void; onContinue: (groupId: number, limit: number) => void }) { const [groupId, setGroupId] = useState(groups[0]?.id ? String(groups[0].id) : ""); const [limit, setLimit] = useState(100); const group = groups.find(item => Number(item.id) === Number(groupId)); const error = !groups.length ? "Create a group before starting a campaign." : !groupId ? "Select a group." : limit < 1 || limit > 2000 ? "Daily limit must be between 1 and 2,000." : null; return <div className="crm-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="new-campaign-title" onMouseDown={onClose}><div className="crm-modal max-w-[500px]" onMouseDown={event => event.stopPropagation()}><div className="flex items-start justify-between border-b border-[#e5e3df] px-5 py-4"><div><h2 id="new-campaign-title" className="text-[14px] font-semibold text-[#24211f]">New campaign</h2><p className="mt-1 text-[10.5px] text-[#77736f]">Choose the audience and a safe daily sending pace.</p></div><button className="crm-icon-button border-0" onClick={onClose}>×</button></div><div className="space-y-4 px-5 py-5"><label><span className="crm-label">Contact group *</span><select className="crm-select" value={groupId} onChange={event => setGroupId(event.target.value)} disabled={!groups.length}>{!groups.length ? <option>No groups available</option> : groups.map(item => <option key={item.id} value={item.id}>{item.name} · {item.member_count} people</option>)}</select></label><label><span className="crm-label">Daily sending limit *</span><input className="crm-input" type="number" min="1" max="2000" value={limit} onChange={event => setLimit(Number(event.target.value))} /><span className="mt-1.5 block text-[10px] text-[#77736f]">{group ? `${group.member_count.toLocaleString()} contacts will be sent over ${Math.max(1, Math.ceil(group.member_count / Math.max(1, limit)))} day(s).` : "Limits protect sender reputation."}</span></label>{error ? <p className="text-[11px] text-[#a32424]">{error}</p> : null}</div><div className="flex justify-end gap-2 border-t border-[#e5e3df] bg-[#faf9f5] px-5 py-4"><button className="crm-button" onClick={onClose}>Cancel</button><button className="crm-button crm-button-primary" disabled={Boolean(error)} onClick={() => onContinue(Number(groupId), limit)}>Continue to email</button></div></div></div>; }
function CampaignPanel({ detail, onClose }: { detail: CampaignDetail; onClose: () => void }) { const c = detail.campaign; return <div className="fixed inset-0 z-[110] flex justify-end bg-[#201a17]/25" onMouseDown={onClose}><aside className="h-full w-full max-w-[520px] overflow-y-auto border-l border-[#d9d7d2] bg-white shadow-[-18px_0_50px_rgba(38,8,5,0.12)]" onMouseDown={event => event.stopPropagation()} aria-label="Campaign details"><div className="sticky top-0 z-10 flex items-start justify-between border-b border-[#e5e3df] bg-white px-5 py-4"><div><span className="text-[9px] uppercase tracking-[0.09em] text-[#77736f]">Campaign details</span><h2 className="mt-1 text-[16px] font-semibold text-[#24211f]">{c.subject}</h2><p className="mt-1 text-[10.5px] text-[#77736f]">{c.group_name || "Deleted group"} · {new Date(c.created_at).toLocaleString()}</p></div><button className="crm-icon-button" onClick={onClose}>×</button></div><div className="space-y-5 p-5"><div className="grid grid-cols-3 overflow-hidden rounded-[6px] border border-[#e5e3df]"><MiniMetric label="Delivered" value={`${rate(c.sent_count, c.recipient_count)}%`} /><MiniMetric label="Opened" value={`${rate(detail.recipients.filter(r => r.opened_at).length, c.sent_count)}%`} /><MiniMetric label="Clicked" value={`${rate(detail.recipients.filter(r => r.clicked_at).length, c.sent_count)}%`} last /></div><section className="crm-panel"><div className="crm-panel-header"><h3 className="crm-section-title">Email sent</h3></div><div className="px-4 py-4"><span className="crm-label">Subject</span><p className="text-[12px] font-medium text-[#24211f]">{c.subject}</p><span className="crm-label mt-4">Message</span><p className="whitespace-pre-wrap text-[11.5px] leading-[1.7] text-[#4f4945]">{c.body_template}</p></div></section><section className="crm-panel"><div className="crm-panel-header"><h3 className="crm-section-title">Recipients</h3><span className="text-[10px] text-[#77736f]">{detail.recipients.length}</span></div><div className="divide-y divide-[#eceae6]">{detail.recipients.map(recipient => <div key={recipient.id} className="flex items-center justify-between gap-3 px-4 py-3"><span className="truncate text-[11px] text-[#3c3834]">{recipient.recipient_email}</span><span className="text-[9.5px] text-[#77736f]">{recipient.clicked_at ? "Clicked" : recipient.opened_at ? "Opened" : recipient.send_status === "sent" ? "Delivered" : "Failed"}</span></div>)}</div></section></div></aside></div>; }
function MiniMetric({ label, value, last }: { label: string; value: string; last?: boolean }) { return <div className={`px-3 py-3 ${last ? "" : "border-r border-[#e5e3df]"}`}><span className="block text-[9px] uppercase tracking-[0.06em] text-[#85807a]">{label}</span><span className="mt-1 block text-[16px] font-semibold text-[#24211f]">{value}</span></div>; }
function normalizeStatus(status: string) { if (["completed"].includes(status)) return "completed"; if (["sending", "scheduled", "pending"].includes(status)) return "active"; if (status === "paused") return "paused"; if (["partial", "failed", "cancelled"].includes(status)) return "failed"; return "draft"; }
function StatusBadge({ status, archived }: { status: string; archived: boolean }) { if (archived) return <span className="crm-status border-[#deddd8] bg-[#f4f3ef] text-[#77736f]">Archived</span>; const style = status === "completed" ? "border-[#c9ded2] bg-[#f2faf5] text-[#096645]" : status === "active" ? "border-[#d7d8ed] bg-[#f5f6ff] text-[#4d5790]" : status === "paused" ? "border-[#e7dcc0] bg-[#fffaf0] text-[#8a6419]" : status === "failed" ? "border-[#e9caca] bg-[#fff7f7] text-[#a32424]" : "border-[#deddd8] bg-[#f4f3ef] text-[#77736f]"; return <span className={`crm-status ${style}`}>{status}</span>; }
function rate(value: number, total: number) { return total ? Math.round(Number(value || 0) / Number(total) * 100) : 0; }
function SearchIcon() { return <svg className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#85807a]" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3"/><path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>; }
function PlusIcon() { return <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>; }
function PauseIcon() { return <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4 3h3v10H4zM9 3h3v10H9z"/></svg>; }
function PlayIcon() { return <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="m5 3 8 5-8 5V3Z"/></svg>; }
function ArchiveIcon() { return <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2.5 4h11v9h-11zM2 2.5h12V5H2zM6 7.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>; }
function TrashIcon() { return <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3.5 4.5h9M6 4.5V3h4v1.5M5 6.5l.5 6h5l.5-6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
