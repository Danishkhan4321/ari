"use client";

import { useEffect, useMemo, useState } from "react";
import { useEntityEvents } from "@/lib/use-entity-events";
import { CrmLoading, CrmState } from "@/components/crm-page";

type Campaign = { id: number; subject: string; recipient_count: number; sent_count: number; failed_count: number; opened_count: number; clicked_count: number; status: string; created_at: string; daily_send_limit?: number };

export function CrmAnalytics() {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [range, setRange] = useState<"30" | "90" | "all">("90");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try { const response = await fetch("/api/campaigns/list", { cache: "no-store" }); const data = await response.json() as { campaigns?: Campaign[]; error?: string }; if (!response.ok) throw new Error(data.error || "Could not load analytics."); setCampaigns(data.campaigns || []); }
    catch (loadError) { setError(loadError instanceof Error ? loadError.message : "Could not load analytics."); setCampaigns([]); }
  }
  useEffect(() => { void load(); }, []);
  // Refetch when the agent mutates CRM data while open (C-2).
  useEntityEvents(["crm", "contacts", "campaigns"], () => void load());

  const visible = useMemo(() => (campaigns || []).filter(campaign => range === "all" || Date.now() - new Date(campaign.created_at).getTime() <= Number(range) * 86400000), [campaigns, range]);
  const totals = visible.reduce((result, campaign) => ({ audience: result.audience + Number(campaign.recipient_count || 0), sent: result.sent + Number(campaign.sent_count || 0), failed: result.failed + Number(campaign.failed_count || 0), opened: result.opened + Number(campaign.opened_count || 0), clicked: result.clicked + Number(campaign.clicked_count || 0) }), { audience: 0, sent: 0, failed: 0, opened: 0, clicked: 0 });
  const metrics = [
    { label: "Emails sent", value: totals.sent.toLocaleString(), detail: `${visible.length} campaigns` },
    { label: "Delivery rate", value: `${rate(totals.sent, totals.audience)}%`, detail: `${totals.sent.toLocaleString()} delivered` },
    { label: "Open rate", value: `${rate(totals.opened, totals.sent)}%`, detail: `${totals.opened.toLocaleString()} unique opens` },
    { label: "Click rate", value: `${rate(totals.clicked, totals.sent)}%`, detail: `${totals.clicked.toLocaleString()} unique clicks` },
    { label: "Reply rate", value: "—", detail: "Connect inbox tracking" },
    { label: "Bounce rate", value: `${rate(totals.failed, totals.audience)}%`, detail: `${totals.failed.toLocaleString()} failed` },
  ];

  if (campaigns === null) return <CrmLoading rows={7} />;
  if (error && campaigns.length === 0) return <CrmState tone="error" title="Analytics unavailable" description={error} action={<button className="crm-button" onClick={() => void load()}>Try again</button>} />;

  return <div className="space-y-5">
    <div className="flex justify-end"><label className="flex items-center gap-2 text-[10.5px] text-[#77736f]">Date range<select className="crm-select w-auto min-w-[120px]" value={range} onChange={event => setRange(event.target.value as typeof range)}><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="all">All time</option></select></label></div>
    <section className="crm-panel">
      <div className="crm-panel-header"><div><h2 className="crm-section-title">Email performance</h2><p className="mt-1 text-[10.5px] text-[#77736f]">Unique recipient engagement for the selected period.</p></div></div>
      <div className="grid sm:grid-cols-2 xl:grid-cols-3">{metrics.map((metric, index) => <div key={metric.label} className={`px-5 py-5 ${index < metrics.length - 1 ? "border-b border-[#e5e3df]" : ""} sm:border-r sm:[&:nth-child(2n)]:border-r-0 xl:[&:nth-child(2n)]:border-r xl:[&:nth-child(3n)]:border-r-0 xl:[&:nth-last-child(-n+3)]:border-b-0`}><span className="text-[9.5px] font-medium uppercase tracking-[0.07em] text-[#85807a]">{metric.label}</span><span className="mt-2 block text-[24px] font-semibold tracking-[-0.045em] text-[#24211f]">{metric.value}</span><span className="mt-1 block text-[10px] text-[#85807a]">{metric.detail}</span></div>)}</div>
    </section>

    <div className="grid gap-5 lg:grid-cols-[1.35fr_.65fr]">
      <section className="crm-panel"><div className="crm-panel-header"><div><h2 className="crm-section-title">Campaign performance</h2><p className="mt-1 text-[10.5px] text-[#77736f]">Compare delivery and engagement by send.</p></div></div>{visible.length === 0 ? <div className="px-5 py-12 text-center text-[11px] text-[#77736f]">No campaigns in this date range.</div> : <div className="crm-table-wrap"><table className="crm-table min-w-[620px]"><thead><tr><th>Campaign</th><th>Sent</th><th>Delivery</th><th>Open</th><th>Click</th><th>Status</th></tr></thead><tbody>{visible.slice(0, 8).map(campaign => <tr key={campaign.id}><td><span className="font-medium text-[#24211f]">{campaign.subject}</span><span className="block text-[9.5px] text-[#85807a]">{new Date(campaign.created_at).toLocaleDateString()}</span></td><td>{campaign.sent_count}</td><td>{rate(campaign.sent_count, campaign.recipient_count)}%</td><td>{rate(campaign.opened_count, campaign.sent_count)}%</td><td>{rate(campaign.clicked_count, campaign.sent_count)}%</td><td><span className="crm-status border-[#deddd8] bg-[#faf9f5] text-[#625d58]">{campaign.status}</span></td></tr>)}</tbody></table></div>}</section>
      <section className="crm-panel self-start"><div className="crm-panel-header"><h2 className="crm-section-title">Sending pace</h2></div><div className="p-5"><div className="rounded-[6px] border border-[#e4dfc8] bg-[#fffdf2] p-4"><span className="text-[9.5px] uppercase tracking-[0.07em] text-[#77736f]">Example plan</span><p className="mt-2 text-[14px] font-semibold tracking-[-0.025em] text-[#24211f]">1,000 contacts</p><div className="mt-4 space-y-3"><PaceRow label="Daily limit" value="100 emails" /><PaceRow label="Estimated duration" value="10 days" /><PaceRow label="Automatic batches" value="10" /></div></div><p className="mt-4 text-[10.5px] leading-[1.6] text-[#77736f]">Campaign pacing spreads delivery across daily batches to protect sender reputation and make performance easier to monitor.</p></div></section>
    </div>
  </div>;
}

function PaceRow({ label, value }: { label: string; value: string }) { return <div className="flex items-center justify-between border-b border-[#e9e4cf] pb-2 text-[10.5px] last:border-b-0 last:pb-0"><span className="text-[#77736f]">{label}</span><span className="font-medium text-[#24211f]">{value}</span></div>; }
function rate(value: number, total: number) { return total ? Math.round(Number(value || 0) / Number(total) * 100) : 0; }
