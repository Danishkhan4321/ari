"use client";

// Home-page KPI strip for Ari's dashboard.
// Each card has a colored accent bar on top + a subtle hover lift, and
// pulls live numbers from /api/kpis (active reminders / open deals /
// pipeline value / messages last 24h).
import { useEffect, useState } from "react";

type Kpis = {
  active_reminders: number;
  open_deals: number;
  pipeline_value: number;
  recent_messages: number;
};

export function KpiStrip() {
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/kpis", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { kpis?: Kpis };
        if (!cancelled && data.kpis) { setKpis(data.kpis); setError(null); }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void tick();
    const handle = setInterval(tick, 30_000);
    return () => { cancelled = true; clearInterval(handle); };
  }, []);

  const cards = [
    { label: "Active reminders", value: kpis?.active_reminders, hint: "pending",      accent: "#5A37D6" },
    { label: "Open deals",       value: kpis?.open_deals,       hint: "in pipeline",  accent: "#6E49E8" },
    { label: "Pipeline value",   value: kpis ? `$${formatMoney(kpis.pipeline_value)}` : null, hint: "open total", accent: "#8A65FF" },
    { label: "Recent messages",  value: kpis?.recent_messages,  hint: "last 24h",     accent: "#D8CCFF" },
  ];

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-5 min-w-0">
      {cards.map((c) => (
        <div
          key={c.label}
          className="dash-card px-5 py-5 relative overflow-hidden cursor-default transition-all duration-200 hover:-translate-y-0.5"
        >
          <span
            className="absolute top-0 left-0 right-0 h-[3px]"
            style={{ background: c.accent }}
          />
          <div className="dash-label">{c.label}</div>
          <div className="flex items-baseline gap-2 mt-4">
            <div className="num text-[30px] font-semibold tracking-tight leading-none">
              {c.value === null || c.value === undefined ? <Skeleton /> : c.value}
            </div>
            <div className="text-[11px] text-[#a3a3a3]">{c.hint}</div>
          </div>
        </div>
      ))}
      {error && (
        <div className="col-span-full text-xs text-[#a3a3a3]">⚠️ {error}</div>
      )}
    </div>
  );
}

function Skeleton() {
  return <span className="inline-block h-7 w-12 bg-black/10 rounded animate-pulse" />;
}

function formatMoney(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return Math.round(n).toLocaleString();
}
