"use client";

// Productivity — demo-styled. Three sections: Habits / Focus sessions /
// Expenses. Each in dash-card with accent dot. Habits are a chip grid;
// focus sessions are a row list; expenses show a category grid +
// collapsible recent transactions.
import { useEffect, useState } from "react";
import { StatusPill, EmptyState } from "@/components/dash-page";

type Habit = { id: number; name: string; frequency: string; target_count: number | null; active: boolean; log_count: number };
type Focus = { id: number; duration_mins: number; mode: string | null; status: string | null; label: string | null };
type Expense = { id: number; amount: string; currency: string | null; category: string | null; description: string | null; date: string };
type ExpCat = { category: string | null; total: string; n: number };
type SelfStandup = {
  id: number; date: string;
  yesterday_done: string | null; today_plan: string | null; blockers: string | null;
  mood: string | null; energy_level: number | null;
  created_at: string;
};

export function ProductivityContent() {
  const [data, setData] = useState<{ habits: Habit[]; focus: Focus[]; expenses: Expense[]; expByCat: ExpCat[]; selfStandups: SelfStandup[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/productivity/overview", { cache: "no-store" })
      .then(r => r.json())
      .then((d: { ok: boolean; habits: Habit[]; focus: Focus[]; expenses: Expense[]; expByCat: ExpCat[]; selfStandups?: SelfStandup[]; error?: string }) =>
        d.ok ? setData({ habits: d.habits, focus: d.focus, expenses: d.expenses, expByCat: d.expByCat, selfStandups: d.selfStandups || [] }) : setError(d.error || "Could not load.")
      )
      .catch(e => setError(String(e)));
  }, []);

  if (!data) {
    return (
      <div className="dash-card p-10 text-center text-[13px] text-[#a3a3a3]">
        {error ? `⚠️ ${error}` : "Loading…"}
      </div>
    );
  }

  const totalFocusMins = data.focus.filter(f => f.status === "completed").reduce((s, f) => s + (f.duration_mins || 0), 0);
  const totalExpenseLast30 = data.expByCat.reduce((s, c) => s + (parseFloat(c.total || "0") || 0), 0);

  const totalEverything = data.habits.length + data.focus.length + data.expenses.length + data.selfStandups.length;
  if (totalEverything === 0) {
    return (
      <EmptyState
        icon="⚡"
        title="No productivity data yet"
        body={
          <>
            Tell Ari: <span className="font-mono">track habit: morning jog</span>{" · "}
            <span className="font-mono">start focus 25 mins</span>{" · "}
            <span className="font-mono">spent $50 on lunch</span>
          </>
        }
      />
    );
  }

  return (
    <div className="space-y-5">
      <SelfStandupCard standups={data.selfStandups} />

      <Card title="Habits" count={data.habits.filter(h => h.active).length} subtitle={`${data.habits.length} total`} accent="#D8CCFF">
        {data.habits.length === 0 ? (
          <Empty>Tell Ari: <span className="font-mono">track habit: morning jog</span></Empty>
        ) : (
          <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-3 p-5">
            {data.habits.map(h => (
              <div
                key={h.id}
                className={`dash-card p-3 ${h.active ? "" : "opacity-60"}`}
                style={h.active ? { background: "rgba(155, 231, 191, 0.18)" } : undefined}
              >
                <div className="text-[13.5px] font-medium truncate">{h.name}</div>
                <div className="flex items-center justify-between text-[11px] text-[#737373] mt-2">
                  <span>{h.frequency}{h.target_count ? ` · ${h.target_count}/day` : ""}</span>
                  <span className="num font-semibold text-[#0a0a0a]">{h.log_count}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Focus sessions" count={data.focus.length} subtitle={`${Math.round(totalFocusMins / 60)}h logged`} accent="#8A65FF">
        {data.focus.length === 0 ? (
          <Empty>Tell Ari: <span className="font-mono">start focus 25 mins</span></Empty>
        ) : (
          <ul>
            {data.focus.slice(0, 12).map((f, i, arr) => (
              <li
                key={f.id}
                className={`px-5 py-3 flex items-center justify-between gap-3 hover:bg-[#FBFAFE] transition-colors ${
                  i !== arr.length - 1 ? "border-b border-[#E8E3ED]" : ""
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium truncate">{f.label || "(no label)"}</div>
                  {f.mode && <div className="text-[11px] text-[#737373] mt-0.5">{f.mode}</div>}
                </div>
                <span className="num text-[12.5px] font-medium tabular-nums">{f.duration_mins}m</span>
                <StatusPill color={f.status === "completed" ? "#3FAA6E" : "#8A65FF"}>
                  {f.status || "—"}
                </StatusPill>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Expenses · last 30 days" count={data.expenses.length} subtitle={`$${formatNum(totalExpenseLast30)} total`} accent="#FFB1D8">
        {data.expByCat.length === 0 ? (
          <Empty>Tell Ari: <span className="font-mono">spent $50 on lunch</span></Empty>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 p-5">
              {data.expByCat.map(c => (
                <div key={c.category || "uncategorized"} className="dash-card p-3">
                  <div className="text-[11px] text-[#737373] truncate">{c.category || "uncategorized"}</div>
                  <div className="num text-[18px] font-semibold mt-1">${formatNum(parseFloat(c.total))}</div>
                  <div className="text-[10px] text-[#a3a3a3] mt-0.5">{c.n} txn</div>
                </div>
              ))}
            </div>
            {data.expenses.length > 0 && (
              <details className="border-t border-[#E8E3ED]">
                <summary className="cursor-pointer px-5 py-3 text-[12.5px] text-[#737373] hover:bg-[#FBFAFE] transition-colors">
                  Recent transactions ({data.expenses.length})
                </summary>
                <ul>
                  {data.expenses.slice(0, 30).map((e, i, arr) => (
                    <li
                      key={e.id}
                      className={`px-5 py-2.5 flex items-center justify-between gap-3 text-[13px] ${
                        i !== arr.length - 1 ? "border-b border-[#E8E3ED]" : ""
                      }`}
                    >
                      <span className="truncate">
                        <span className="text-[11px] text-[#737373] mr-2 num">{fmtDate(e.date)}</span>
                        {e.description || e.category || "(uncategorized)"}
                      </span>
                      <span className="num font-medium flex-shrink-0">${formatNum(parseFloat(e.amount))}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

function SelfStandupCard({ standups }: { standups: SelfStandup[] }) {
  const today = standups[0];
  const todayIso = new Date().toISOString().slice(0, 10);
  const submittedToday = today && today.date.slice(0, 10) === todayIso;
  return (
    <div className="dash-card overflow-hidden">
      <div className="px-5 py-4 border-b border-[#E8E3ED] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-[#8A65FF]" />
          <h2 className="dash-h2">Self-standup</h2>
          {submittedToday ? (
            <span className="text-[10.5px] uppercase tracking-wider font-bold bg-[#D8CCFF]/40 border border-[#3FAA6E] text-[#0a0a0a] px-1.5 py-0.5 rounded">
              today logged
            </span>
          ) : (
            <span className="text-[10.5px] uppercase tracking-wider font-bold bg-[#D8CCFF]/40 border border-[#0a0a0a]/30 text-[#0a0a0a] px-1.5 py-0.5 rounded">
              today not logged
            </span>
          )}
        </div>
        <span className="text-[11px] text-[#737373]">{standups.length} of last 7 days</span>
      </div>
      {standups.length === 0 ? (
        <div className="text-[13px] text-[#737373] py-8 text-center px-5">
          Tell Ari: <span className="font-mono">standup yesterday: shipped X · today: ship Y · blockers: none</span>
          <div className="text-[11.5px] text-[#a3a3a3] mt-2">She tracks mood + energy automatically too.</div>
        </div>
      ) : (
        <ul>
          {standups.slice(0, 7).map((s, i, arr) => (
            <li key={s.id} className={`px-5 py-3 ${i !== arr.length - 1 ? "border-b border-[#E8E3ED]" : ""}`}>
              <div className="flex items-center gap-2 mb-2">
                <span className="dash-label">{fmtDate(s.date)}</span>
                {s.mood && <span className="text-[11.5px] text-[#737373]">· {s.mood}</span>}
                {s.energy_level !== null && (
                  <span className="text-[11.5px] text-[#737373]">· energy {s.energy_level}/10</span>
                )}
              </div>
              <div className="text-[13px] grid sm:grid-cols-3 gap-3">
                {s.yesterday_done && (
                  <div>
                    <div className="text-[10.5px] uppercase tracking-wider font-semibold text-[#a3a3a3] mb-0.5">Yesterday</div>
                    <div className="text-[#404040] leading-snug whitespace-pre-wrap break-words">{s.yesterday_done}</div>
                  </div>
                )}
                {s.today_plan && (
                  <div>
                    <div className="text-[10.5px] uppercase tracking-wider font-semibold text-[#a3a3a3] mb-0.5">Today</div>
                    <div className="text-[#404040] leading-snug whitespace-pre-wrap break-words">{s.today_plan}</div>
                  </div>
                )}
                {s.blockers && (
                  <div>
                    <div className="text-[10.5px] uppercase tracking-wider font-semibold text-[#ef4444] mb-0.5">Blockers</div>
                    <div className="text-[#404040] leading-snug whitespace-pre-wrap break-words">{s.blockers}</div>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Card({ title, count, subtitle, accent, children }: {
  title: string; count: number; subtitle?: string; accent: string; children: React.ReactNode;
}) {
  return (
    <div className="dash-card overflow-hidden">
      <div className="px-5 py-4 border-b border-[#E8E3ED] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: accent }} />
          <h2 className="dash-h2">{title}</h2>
          <span className="text-[11px] text-[#a3a3a3] num">({count})</span>
        </div>
        {subtitle && <span className="text-[11px] text-[#737373]">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-[13px] text-[#737373] py-8 text-center">{children}</div>;
}
function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return Math.round(n).toLocaleString();
}
function fmtDate(s: string): string {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
