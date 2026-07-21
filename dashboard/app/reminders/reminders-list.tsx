"use client";

// Reminders list — demo-styled. Tabs filter Active / Snoozed / Done /
// All. Each row is a horizontal card row with a circular tick-toggle
// (mark done), the message, the when/recurring meta, and hover-revealed
// Snooze + Cancel actions. Hero dash-card wraps the list.
import { useEffect, useMemo, useState } from "react";
import { PageHead, StatusPill, Tabs, EmptyState } from "@/components/dash-page";

type Row = {
  id: number;
  message: string;
  reminder_time: string;
  status: string;
  is_recurring: boolean;
  recurrence_pattern: string | null;
  recurrence_days: string | null;
  recurrence_time: string | null;
  next_occurrence: string | null;
  snooze_until: string | null;
  created_at: string;
};

type FilterKey = "active" | "snoozed" | "done" | "all";

const SNOOZES = [
  { label: "1 hour" },
  { label: "Tonight 9pm" },
  { label: "Tomorrow 9am" },
  { label: "Next week" },
] as const;

function snoozeIso(label: string): string {
  const now = new Date();
  if (label === "Tonight 9pm") {
    const t = new Date(now); t.setHours(21, 0, 0, 0);
    if (t.getTime() < now.getTime()) t.setDate(t.getDate() + 1);
    return t.toISOString();
  }
  if (label === "Tomorrow 9am") {
    const t = new Date(now); t.setDate(t.getDate() + 1); t.setHours(9, 0, 0, 0);
    return t.toISOString();
  }
  if (label === "Next week") {
    return new Date(now.getTime() + 7 * 24 * 60 * 60_000).toISOString();
  }
  return new Date(now.getTime() + 60 * 60_000).toISOString(); // 1 hour
}

export function RemindersList() {
  const [active, setActive] = useState<Row[] | null>(null);
  const [past, setPast] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [showSnoozeFor, setShowSnoozeFor] = useState<number | null>(null);
  const [filter, setFilter] = useState<FilterKey>("active");

  async function refresh() {
    try {
      const res = await fetch("/api/reminders/list", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { active: Row[]; past: Row[] };
      setActive(data.active);
      setPast(data.past || []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load reminders.");
    }
  }
  useEffect(() => { void refresh(); }, []);

  async function act(id: number, action: "cancel" | "done" | "snooze", snoozeUntil?: string) {
    setBusy(id);
    try {
      const res = await fetch("/api/reminders/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action, snoozeUntil }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error || `Failed (${res.status}).`);
      } else {
        await refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(null);
      setShowSnoozeFor(null);
    }
  }

  // Bucket rows by tab
  const buckets = useMemo(() => {
    const a = active ?? [];
    const p = past ?? [];
    const snoozed = a.filter(r => Boolean(r.snooze_until));
    const liveActive = a.filter(r => !r.snooze_until);
    const done = p.filter(r => r.status === "done" || r.status === "completed");
    return { active: liveActive, snoozed, done, all: [...a, ...p] };
  }, [active, past]);

  const counts = {
    active: buckets.active.length,
    snoozed: buckets.snoozed.length,
    done: buckets.done.length,
    all: buckets.all.length,
  };
  const visible: Row[] = buckets[filter];

  if (active === null) {
    return (
      <>
        <PageHead title="Reminders" subtitle="Loading…" />
        <div className="dash-card p-10 text-center text-[13px] text-[#a3a3a3]">Loading…</div>
      </>
    );
  }

  return (
    <>
      <PageHead
        title="Reminders"
        subtitle={
          <>
            Snooze, mark done, or cancel. Create new reminders via WhatsApp:{" "}
            <span className="font-mono text-[12.5px] bg-white border border-[#E8E3ED] rounded px-1.5 py-0.5">
              remind me at 5pm to call mom
            </span>
          </>
        }
        badge={{ label: `${counts.active} active`, color: "#8A65FF" }}
      />

      {/* Filter row */}
      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <Tabs<FilterKey>
          value={filter}
          onChange={setFilter}
          options={[
            { value: "active",  label: "Active",  count: counts.active },
            { value: "snoozed", label: "Snoozed", count: counts.snoozed },
            { value: "done",    label: "Done",    count: counts.done },
            { value: "all",     label: "All",     count: counts.all },
          ]}
        />
      </div>

      {error && (
        <div className="dash-card bg-[#FFB1D8]/30 border border-[#FFB1D8] px-4 py-3 text-sm mb-4">⚠️ {error}</div>
      )}

      {visible.length === 0 ? (
        <EmptyState
          icon="🔔"
          title={filter === "done" ? "Nothing finished yet" : "Nothing here"}
          body={
            filter === "active"
              ? "No active reminders. Tell Ari on WhatsApp what to remind you about."
              : filter === "snoozed"
              ? "No snoozed reminders. Snoozed ones will appear here when you push them off."
              : filter === "done"
              ? "Reminders you mark done land here for review."
              : "No reminders yet. Add one via WhatsApp."
          }
        />
      ) : (
        <section className="dash-card-hero overflow-hidden">
          <ul>
            {visible.map((r, i) => {
              const isDone = r.status === "done" || r.status === "completed";
              const isSnoozed = Boolean(r.snooze_until);
              const isHistory = filter === "done" || (filter === "all" && isDone);
              return (
                <li
                  key={r.id}
                  className={`flex items-center gap-4 px-6 py-4 hover:bg-[#FBFAFE] transition-colors group ${
                    i !== visible.length - 1 ? "border-b border-[#E8E3ED]" : ""
                  }`}
                >
                  <button
                    disabled={busy === r.id || isHistory}
                    onClick={() => act(r.id, "done")}
                    aria-label={isDone ? "Done" : "Mark done"}
                    className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-all ${
                      isDone
                        ? "bg-[#3FAA6E] border-[#3FAA6E] text-white"
                        : "border-[#d4d4d4] hover:border-[#0a0a0a]"
                    } disabled:opacity-50`}
                  >
                    {isDone && (
                      <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                        <path d="M3 6l2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </button>

                  <div className="flex-1 min-w-0">
                    <div className={`text-[13.5px] font-medium truncate ${
                      isDone ? "line-through text-[#a3a3a3]" : "text-[#0a0a0a]"
                    }`}>
                      {r.message}
                    </div>
                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                      <span className="text-[11.5px] text-[#737373] num">{fmtWhen(r)}</span>
                      {r.is_recurring && (
                        <>
                          <span className="w-1 h-1 rounded-full bg-[#d4d4d4]" />
                          <span className="text-[11px] text-[#737373] inline-flex items-center gap-1">
                            <RepeatIcon /> {recurrenceLabel(r)}
                          </span>
                        </>
                      )}
                      {isSnoozed && (
                        <>
                          <span className="w-1 h-1 rounded-full bg-[#d4d4d4]" />
                          <StatusPill color="#D8CCFF">Snoozed</StatusPill>
                        </>
                      )}
                    </div>
                  </div>

                  {!isHistory && (
                    <div className="opacity-0 group-hover:opacity-100 flex gap-1 transition-opacity flex-shrink-0">
                      {showSnoozeFor === r.id ? (
                        <>
                          {SNOOZES.map((s) => (
                            <button
                              key={s.label}
                              disabled={busy === r.id}
                              onClick={() => act(r.id, "snooze", snoozeIso(s.label))}
                              className="dash-btn !py-1 !px-2.5 !text-[11px] disabled:opacity-50"
                            >
                              {s.label}
                            </button>
                          ))}
                          <button onClick={() => setShowSnoozeFor(null)} className="dash-btn !py-1 !px-2.5 !text-[11px]">
                            ×
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            disabled={busy === r.id}
                            onClick={() => setShowSnoozeFor(r.id)}
                            className="dash-btn !py-1 !px-2.5 !text-[11px] disabled:opacity-50"
                          >
                            Snooze
                          </button>
                          <button
                            disabled={busy === r.id}
                            onClick={() => act(r.id, "cancel")}
                            className="dash-btn !py-1 !px-2.5 !text-[11px] disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <p className="text-[12px] text-[#a3a3a3] mt-4 text-center">
        Showing {visible.length} of {counts.all} reminder{counts.all === 1 ? "" : "s"}
      </p>
    </>
  );
}

function RepeatIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
      <path
        d="M2 5a4 4 0 016-2.5M10 7a4 4 0 01-6 2.5M9 1v3h-3M3 11v-3h3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function fmtWhen(r: Row): string {
  const target = r.snooze_until || r.next_occurrence || r.reminder_time;
  if (!target) return "";
  const d = new Date(target);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

function recurrenceLabel(r: Row): string {
  if (!r.is_recurring) return "";
  const t = r.recurrence_time ? r.recurrence_time.slice(0, 5) : "";
  const days = r.recurrence_days || "";
  const pattern = r.recurrence_pattern || "";
  return [pattern, days, t].filter(Boolean).join(" · ");
}
