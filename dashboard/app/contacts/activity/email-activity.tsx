"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CrmLoading, CrmPagination, CrmState } from "@/components/crm-page";

type Campaign = { id: number; group_id: number | null; group_name?: string | null; subject: string; body_template?: string; recipient_count: number; sent_count: number; failed_count: number; status: string; scheduled_for: string | null; created_at: string; completed_at: string | null; opened_count: number; clicked_count: number; daily_send_limit?: number };
type Recipient = { id: number; recipient_email: string; subject: string | null; send_status: string; send_error: string | null; opened_at: string | null; open_count: number; clicked_at: string | null; click_count: number; sent_at: string };
type Detail = { campaign: Campaign; recipients: Recipient[] };
const PAGE_SIZE = 8;

export function EmailActivity() {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [groups, setGroups] = useState<{ id: number; name: string }[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("newest");
  const [page, setPage] = useState(1);
  const [loadingDetail, setLoadingDetail] = useState(false);

  async function load() {
    setError(null);
    try {
      const [campaignResponse, groupResponse] = await Promise.all([fetch("/api/campaigns/list", { cache: "no-store" }), fetch("/api/groups/list", { cache: "no-store" })]);
      const campaignData = await campaignResponse.json() as { campaigns?: Campaign[]; error?: string };
      const groupData = await groupResponse.json() as { groups?: { id: number; name: string }[] };
      if (!campaignResponse.ok) throw new Error(campaignData.error || "Could not load email activity.");
      setCampaigns(campaignData.campaigns || []); setGroups(groupData.groups || []);
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "Could not load email activity."); setCampaigns([]); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => { setPage(1); }, [query, status, sort]);

  const groupName = useCallback((id: number | null) => groups.find(group => Number(group.id) === Number(id))?.name || "Deleted group", [groups]);
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return (campaigns || []).filter(campaign => (!term || campaign.subject.toLowerCase().includes(term) || groupName(campaign.group_id).toLowerCase().includes(term)) && (status === "all" || activityStatus(campaign.status) === status)).sort((a, b) => sort === "opens" ? rate(b.opened_count, b.sent_count) - rate(a.opened_count, a.sent_count) : sort === "audience" ? b.recipient_count - a.recipient_count : Number(b.id) - Number(a.id));
  }, [campaigns, groupName, query, status, sort]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  async function openDetail(campaign: Campaign) {
    setLoadingDetail(true); setError(null);
    try { const response = await fetch(`/api/campaigns/${campaign.id}`, { cache: "no-store" }); const data = await response.json() as Detail & { error?: string }; if (!response.ok) throw new Error(data.error || "Could not load send details."); setDetail(data); }
    catch (detailError) { setError(detailError instanceof Error ? detailError.message : "Could not load send details."); }
    finally { setLoadingDetail(false); }
  }

  return <div className="space-y-4">
    <section className="crm-panel">
      <div className="crm-panel-header"><div className="relative min-w-[220px] flex-1 sm:max-w-[360px]"><SearchIcon /><input className="crm-input pl-9" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search sends or audiences" /></div><div className="flex flex-wrap gap-2"><select className="crm-select w-auto min-w-[125px]" value={status} onChange={event => setStatus(event.target.value)}><option value="all">All activity</option><option value="active">Active</option><option value="completed">Completed</option><option value="failed">Failed</option></select><select className="crm-select w-auto min-w-[130px]" value={sort} onChange={event => setSort(event.target.value)}><option value="newest">Newest first</option><option value="opens">Highest open rate</option><option value="audience">Largest audience</option></select></div></div>
      {error ? <div className="border-b border-[#e9caca] bg-[#fffafa] px-4 py-3 text-[11.5px] text-[#a32424]" role="alert">{error} <button className="ml-2 underline" onClick={() => void load()}>Try again</button></div> : null}
      {campaigns === null ? <CrmLoading rows={7} /> : rows.length === 0 ? <div className="p-4"><CrmState title={query || status !== "all" ? "No sends match these filters" : "No email activity yet"} description={query || status !== "all" ? "Adjust the search or status filter." : "Campaign sends will appear here with delivery and engagement outcomes."} /></div> : <div className="crm-table-wrap"><table className="crm-table"><thead><tr><th>Send</th><th>Audience</th><th>Sent</th><th>Delivered</th><th>Opened</th><th>Clicked</th><th>Status</th><th className="w-20 text-right">Action</th></tr></thead><tbody>{rows.map(campaign => <tr key={campaign.id}><td><button className="text-left" onClick={() => void openDetail(campaign)}><span className="block font-medium text-[#171717] hover:text-ari-ink hover:underline hover:decoration-[#dec51f]">{campaign.subject}</span><span className="block text-[10px] text-[#85807a]">{new Date(campaign.created_at).toLocaleString()}</span></button></td><td>{groupName(campaign.group_id)}<span className="block text-[10px] text-[#85807a]">{campaign.recipient_count} recipients</span></td><td className="num">{campaign.sent_count}</td><td><span className="font-medium text-[#24211f]">{rate(campaign.sent_count, campaign.recipient_count)}%</span><span className="block text-[10px] text-[#85807a]">{campaign.sent_count} delivered</span></td><td><span className="font-medium text-[#24211f]">{rate(campaign.opened_count, campaign.sent_count)}%</span><span className="block text-[10px] text-[#85807a]">{campaign.opened_count} people</span></td><td><span className="font-medium text-[#24211f]">{rate(campaign.clicked_count, campaign.sent_count)}%</span><span className="block text-[10px] text-[#85807a]">{campaign.clicked_count} people</span></td><td><ActivityBadge status={activityStatus(campaign.status)} /></td><td><div className="flex justify-end"><button className="crm-button min-h-8 px-2.5" onClick={() => void openDetail(campaign)} disabled={loadingDetail}>View</button></div></td></tr>)}</tbody></table></div>}
      {campaigns !== null && filtered.length ? <CrmPagination page={Math.min(page, pageCount)} pageCount={pageCount} total={filtered.length} onPage={setPage} /> : null}
    </section>
    {detail ? <ActivityPanel detail={detail} onClose={() => setDetail(null)} /> : null}
  </div>;
}

function ActivityPanel({ detail, onClose }: { detail: Detail; onClose: () => void }) { const campaign = detail.campaign; const delivered = detail.recipients.filter(item => item.send_status === "sent").length; const opened = detail.recipients.filter(item => item.opened_at).length; const clicked = detail.recipients.filter(item => item.clicked_at).length; const failed = detail.recipients.filter(item => item.send_status !== "sent").length; return <div className="fixed inset-0 z-[110] flex justify-end bg-[#201a17]/25" onMouseDown={onClose}><aside className="h-full w-full max-w-[560px] overflow-y-auto border-l border-[#d9d7d2] bg-white shadow-[-18px_0_50px_rgba(38,8,5,0.12)]" onMouseDown={event => event.stopPropagation()} aria-label="Email activity details"><div className="sticky top-0 z-10 flex items-start justify-between border-b border-[#e5e3df] bg-white px-5 py-4"><div><span className="text-[9px] uppercase tracking-[0.09em] text-[#77736f]">Send details</span><h2 className="mt-1 text-[16px] font-semibold text-[#24211f]">{campaign.subject}</h2><p className="mt-1 text-[10.5px] text-[#77736f]">{campaign.group_name || "Audience"} · {new Date(campaign.created_at).toLocaleString()}</p></div><button className="crm-icon-button" onClick={onClose} aria-label="Close activity details">×</button></div><div className="space-y-5 p-5"><section className="crm-panel"><div className="crm-panel-header"><h3 className="crm-section-title">Campaign performance</h3></div><div className="grid grid-cols-2 sm:grid-cols-4"><Metric label="Delivery rate" value={`${rate(delivered, campaign.recipient_count)}%`} detail={`${delivered}/${campaign.recipient_count}`} /><Metric label="Open rate" value={`${rate(opened, delivered)}%`} detail={`${opened} people`} /><Metric label="Click rate" value={`${rate(clicked, delivered)}%`} detail={`${clicked} people`} /><Metric label="Failed" value={`${rate(failed, campaign.recipient_count)}%`} detail={`${failed} people`} last /></div></section><section className="crm-panel"><div className="crm-panel-header"><h3 className="crm-section-title">Email sent</h3></div><div className="px-4 py-4"><span className="crm-label">Subject</span><p className="text-[12px] font-medium text-[#24211f]">{campaign.subject}</p><span className="crm-label mt-4">Message</span><p className="whitespace-pre-wrap text-[11.5px] leading-[1.7] text-[#4f4945]">{campaign.body_template || "Email body unavailable."}</p></div></section><section className="crm-panel"><div className="crm-panel-header"><h3 className="crm-section-title">Recipients</h3><span className="text-[10px] text-[#77736f]">{detail.recipients.length}</span></div><div className="divide-y divide-[#eceae6]">{detail.recipients.map(recipient => <div key={recipient.id} className="flex items-center justify-between gap-3 px-4 py-3"><div className="min-w-0"><span className="block truncate text-[11px] font-medium text-[#3c3834]">{recipient.recipient_email}</span>{recipient.send_error ? <span className="block truncate text-[9.5px] text-[#a32424]">{recipient.send_error}</span> : null}</div><span className={`crm-status ${recipient.clicked_at ? "border-[#c9ded2] bg-[#f2faf5] text-[#096645]" : recipient.opened_at ? "border-[#d7d8ed] bg-[#f5f6ff] text-[#4d5790]" : recipient.send_status === "sent" ? "border-[#deddd8] bg-[#faf9f5] text-[#625d58]" : "border-[#e9caca] bg-[#fff7f7] text-[#a32424]"}`}>{recipient.clicked_at ? "Clicked" : recipient.opened_at ? `Opened ${recipient.open_count || 1}×` : recipient.send_status === "sent" ? "Delivered" : "Failed"}</span></div>)}</div></section></div></aside></div>; }
function Metric({ label, value, detail, last }: { label: string; value: string; detail: string; last?: boolean }) { return <div className={`px-4 py-4 ${last ? "" : "border-b border-r border-[#e5e3df] sm:border-b-0"}`}><span className="text-[9px] uppercase tracking-[0.06em] text-[#85807a]">{label}</span><span className="mt-1 block text-[17px] font-semibold tracking-[-0.03em] text-[#24211f]">{value}</span><span className="text-[9.5px] text-[#85807a]">{detail}</span></div>; }
function activityStatus(value: string) { if (["completed"].includes(value)) return "completed"; if (["sending", "scheduled", "pending", "paused"].includes(value)) return "active"; return "failed"; }
function ActivityBadge({ status }: { status: string }) { const style = status === "completed" ? "border-[#c9ded2] bg-[#f2faf5] text-[#096645]" : status === "active" ? "border-[#d7d8ed] bg-[#f5f6ff] text-[#4d5790]" : "border-[#e9caca] bg-[#fff7f7] text-[#a32424]"; return <span className={`crm-status ${style}`}>{status}</span>; }
function rate(value: number, total: number) { return total ? Math.round(Number(value || 0) / Number(total) * 100) : 0; }
function SearchIcon() { return <svg className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#85807a]" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3"/><path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>; }
