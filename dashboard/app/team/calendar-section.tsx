"use client";

// Team calendar — Google-Calendar-style month grid. Combines leave,
// past meetings, sprint deadlines, 1:1s, birthdays, anniversaries,
// reminders, tasks with due dates, and poll deadlines.
//
// May 10 2026 — replaced the vertical timeline list with a 7×6 month
// grid. Click a day to expand events in a side panel. Filter chips
// at the top scope the view to a single member or "Mine".
import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "@/components/dash-page";

type EventKind =
  | "leave"
  | "meeting"
  | "sprint_end"
  | "one_on_one"
  | "birthday"
  | "anniversary"
  | "reminder"
  | "task"
  | "poll";

type Event = {
  kind: EventKind;
  start: string;            // ISO date or datetime
  end: string | null;       // ISO date for spans
  member_phone: string | null;
  member_name: string | null;
  title: string;
  detail: string | null;
  time: string | null;      // HH:MM or null for all-day
};

type Member = { phone: string; name: string };

// Colors mirror Google Calendar's 9-color palette so each event kind
// is instantly distinguishable. Background is a soft tint, dot is the
// saturated hue used for the leading indicator.
const KIND_STYLE: Record<EventKind, { bg: string; dot: string; label: string }> = {
  leave:        { bg: "#E6F7EE", dot: "#16A34A", label: "Leave" },
  meeting:      { bg: "#E1F1FE", dot: "#0284C7", label: "Meeting" },
  sprint_end:   { bg: "#FEF3C7", dot: "#D97706", label: "Sprint" },
  one_on_one:   { bg: "#FCE7F3", dot: "#DB2777", label: "1:1" },
  birthday:     { bg: "#FFE4E0", dot: "#EA580C", label: "Birthday" },
  anniversary:  { bg: "#EDE4FF", dot: "#7C3AED", label: "Anniversary" },
  reminder:     { bg: "#FEF6E0", dot: "#CA8A04", label: "Reminder" },
  task:         { bg: "#E0E7FF", dot: "#4F46E5", label: "Task" },
  poll:         { bg: "#F3E8FF", dot: "#9333EA", label: "Poll" },
};

const ALL_KINDS: EventKind[] = [
  "leave", "meeting", "sprint_end", "one_on_one", "birthday",
  "anniversary", "reminder", "task", "poll",
];

const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export function CalendarSection({ teamName, currentUserPhone }: { teamName: string; currentUserPhone?: string | null }) {
  // Cursor is the first day of the visible month. The grid always shows
  // 6 weeks (42 cells) starting from the Sunday on or before day 1.
  const [cursor, setCursor] = useState<Date>(() => firstOfMonth(new Date()));
  const [events, setEvents] = useState<Event[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [memberFilter, setMemberFilter] = useState<"all" | "mine" | string>("all");
  const [kindFilter, setKindFilter] = useState<Set<EventKind>>(new Set(ALL_KINDS));

  // The visible window is the 6-week grid, not just the calendar month.
  // We fetch everything in that window so out-of-month days still light up.
  const gridStart = useMemo(() => firstGridDay(cursor), [cursor]);
  const gridEnd   = useMemo(() => addDays(gridStart, 41), [gridStart]);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      // 8s timeout — the previous version had no timeout and could hang
      // forever on a slow query, leaving the user staring at "Loading…".
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const fromIso = isoDate(gridStart);
      const toIso   = isoDate(gridEnd);
      const r = await fetch(
        `/api/team/${encodeURIComponent(teamName)}/calendar?from=${fromIso}&to=${toIso}`,
        { cache: "no-store", signal: ctrl.signal }
      );
      clearTimeout(t);
      const d = await r.json();
      if (d.ok) setEvents(d.events as Event[]);
      else setError(d.error || "Could not load.");
    } catch (e) {
      setError(e instanceof Error
        ? (e.name === "AbortError" ? "Calendar took too long to load. Try again." : e.message)
        : String(e));
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [teamName, cursor.getTime()]);

  // Apply member + kind filters before bucketing into days.
  const filteredEvents = useMemo<Event[]>(() => {
    if (!events) return [];
    return events.filter(e => {
      if (!kindFilter.has(e.kind)) return false;
      if (memberFilter === "all") return true;
      if (memberFilter === "mine") return currentUserPhone ? e.member_phone === currentUserPhone : true;
      return e.member_phone === memberFilter;
    });
  }, [events, memberFilter, kindFilter, currentUserPhone]);

  // Bucket events by ISO day. Leave spans expand into every day they cover
  // so the chip appears across the full vacation, not just the start.
  const eventsByDay = useMemo<Map<string, Event[]>>(() => {
    const byDay = new Map<string, Event[]>();
    const push = (day: string, ev: Event) => {
      let arr = byDay.get(day);
      if (!arr) { arr = []; byDay.set(day, arr); }
      arr.push(ev);
    };
    for (const ev of filteredEvents) {
      const startDay = ev.start.slice(0, 10);
      if (ev.end && ev.end !== startDay) {
        // Span: walk every day from start..end inclusive.
        let cur = new Date(startDay + "T00:00:00");
        const last = new Date(ev.end + "T00:00:00");
        let safety = 0;
        while (cur <= last && safety++ < 60) {
          push(isoDate(cur), ev);
          cur = addDays(cur, 1);
        }
      } else {
        push(startDay, ev);
      }
    }
    // Within each day, sort by time-of-day (all-day floats to top).
    for (const arr of byDay.values()) {
      arr.sort((a, b) => {
        if (a.time && b.time) return a.time.localeCompare(b.time);
        if (a.time) return 1;
        if (b.time) return -1;
        return a.kind.localeCompare(b.kind);
      });
    }
    return byDay;
  }, [filteredEvents]);

  // Members for the filter dropdown — derived from events' member_phone.
  const members = useMemo<Member[]>(() => {
    if (!events) return [];
    const seen = new Map<string, Member>();
    for (const e of events) {
      if (e.member_phone && !seen.has(e.member_phone)) {
        seen.set(e.member_phone, { phone: e.member_phone, name: e.member_name || `+${e.member_phone}` });
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [events]);

  const monthLabel = cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const todayIso = isoDate(new Date());

  function gotoToday() { setCursor(firstOfMonth(new Date())); setSelectedDay(todayIso); }
  function shiftMonth(delta: number) { setCursor(c => firstOfMonth(addDays(c, delta * 31))); }

  function toggleKind(k: EventKind) {
    setKindFilter(prev => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      // Never end up with zero kinds — if user just unchecked the last
      // one, treat it as "show all" instead of an empty calendar.
      return next.size === 0 ? new Set(ALL_KINDS) : next;
    });
  }

  return (
    <div className="space-y-4">
      {/* ── Toolbar ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <button
            onClick={gotoToday}
            className="px-3 h-8 rounded-md border border-[#E8E3ED] bg-white text-[12.5px] font-medium hover:bg-[#FBFAFE]"
          >
            Today
          </button>
          <div className="inline-flex">
            <button
              onClick={() => shiftMonth(-1)}
              aria-label="Previous month"
              className="w-8 h-8 rounded-l-md border border-[#E8E3ED] bg-white text-[#525252] hover:bg-[#FBFAFE] flex items-center justify-center"
            >
              ‹
            </button>
            <button
              onClick={() => shiftMonth(1)}
              aria-label="Next month"
              className="w-8 h-8 rounded-r-md border border-l-0 border-[#E8E3ED] bg-white text-[#525252] hover:bg-[#FBFAFE] flex items-center justify-center"
            >
              ›
            </button>
          </div>
          <h2 className="text-[18px] font-semibold tracking-tight">{monthLabel}</h2>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={memberFilter}
            onChange={(e) => setMemberFilter(e.target.value as typeof memberFilter)}
            className="h-8 px-2 rounded-md border border-[#E8E3ED] bg-white text-[12.5px]"
          >
            <option value="all">All members</option>
            {currentUserPhone && <option value="mine">Just mine</option>}
            {members.map(m => (
              <option key={m.phone} value={m.phone}>{m.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Kind legend / toggle chips ───────────────────────────── */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {ALL_KINDS.map(k => {
          const on = kindFilter.has(k);
          const s = KIND_STYLE[k];
          return (
            <button
              key={k}
              onClick={() => toggleKind(k)}
              aria-pressed={on}
              className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[11.5px] font-medium border transition-colors
                ${on
                  ? "bg-white border-[#E8E3ED] text-[#0a0a0a]"
                  : "bg-transparent border-[#E8E3ED] text-[#a3a3a3] hover:bg-[#FBFAFE]"
                }`}
            >
              <span className="w-2 h-2 rounded-full" style={{ background: on ? s.dot : "#d4d4d4" }} />
              {s.label}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="dash-card bg-[#FFB1D8]/30 border border-[#FFB1D8] px-4 py-3 text-sm">⚠️ {error}</div>
      )}

      {/* ── Grid + side panel ───────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-4">
        <section className="dash-card overflow-hidden">
          {/* Weekday header */}
          <div className="grid grid-cols-7 bg-[#FBFAFE] border-b border-[#E8E3ED]">
            {WEEKDAYS.map(w => (
              <div key={w} className="px-2 py-2 text-[11px] font-bold uppercase tracking-wider text-[#737373] text-center">
                {w}
              </div>
            ))}
          </div>

          {/* 6 weeks × 7 days */}
          <div className="grid grid-cols-7 grid-rows-6">
            {Array.from({ length: 42 }, (_, i) => {
              const day = addDays(gridStart, i);
              const iso = isoDate(day);
              const inMonth = day.getMonth() === cursor.getMonth();
              const isToday = iso === todayIso;
              const isSelected = iso === selectedDay;
              const dayEvents = eventsByDay.get(iso) || [];
              const visible = dayEvents.slice(0, 3);
              const overflow = dayEvents.length - visible.length;
              const isWeekend = day.getDay() === 0 || day.getDay() === 6;
              return (
                <button
                  key={iso}
                  onClick={() => setSelectedDay(iso === selectedDay ? null : iso)}
                  className={`
                    relative text-left min-h-[96px] lg:min-h-[110px] p-1.5 border-r border-b border-[#E8E3ED]
                    ${(i + 1) % 7 === 0 ? "border-r-0" : ""}
                    ${i >= 35 ? "border-b-0" : ""}
                    ${inMonth ? "bg-white" : "bg-[#FBFAFE]/40"}
                    ${isWeekend && inMonth ? "bg-[#FBFAFE]/60" : ""}
                    ${isSelected ? "ring-2 ring-inset ring-[#0a0a0a]" : ""}
                    hover:bg-[#FBFAFE] transition-colors
                  `}
                >
                  <div className="flex items-start justify-between mb-1">
                    <span
                      className={`
                        inline-flex items-center justify-center text-[12px] font-semibold
                        ${isToday ? "w-6 h-6 rounded-full bg-[#0a0a0a] text-white" : ""}
                        ${!isToday && inMonth ? "text-[#0a0a0a]" : ""}
                        ${!inMonth ? "text-[#a3a3a3]" : ""}
                      `}
                    >
                      {day.getDate()}
                    </span>
                    {dayEvents.length > 0 && !isToday && (
                      <span className="text-[10px] text-[#a3a3a3]">{dayEvents.length}</span>
                    )}
                  </div>
                  <div className="space-y-0.5">
                    {visible.map((ev, j) => {
                      const s = KIND_STYLE[ev.kind];
                      return (
                        <div
                          key={j}
                          title={ev.title}
                          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] leading-tight truncate"
                          style={{ background: s.bg, color: "#0a0a0a" }}
                        >
                          <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: s.dot }} />
                          {ev.time && <span className="font-mono text-[10px] text-[#525252] flex-shrink-0">{ev.time}</span>}
                          <span className="truncate">{ev.title}</span>
                        </div>
                      );
                    })}
                    {overflow > 0 && (
                      <div className="px-1.5 text-[10px] text-[#737373] font-medium">+{overflow} more</div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* ── Side panel: selected day's full event list ────────── */}
        <aside className="dash-card overflow-hidden">
          {selectedDay ? (
            <DayDetailPanel
              dayIso={selectedDay}
              events={eventsByDay.get(selectedDay) || []}
              onClose={() => setSelectedDay(null)}
            />
          ) : (
            <div className="p-6 text-center">
              <div className="text-[28px] mb-2">📅</div>
              <div className="text-[13.5px] font-semibold text-[#0a0a0a] mb-1">Click a day to see details</div>
              <div className="text-[12px] text-[#737373] leading-relaxed">
                {loading ? "Loading events…" :
                  filteredEvents.length === 0
                    ? "No events match the current filters."
                    : `${filteredEvents.length} event${filteredEvents.length === 1 ? "" : "s"} this view.`}
              </div>
            </div>
          )}
        </aside>
      </div>

      {/* ── Empty state when month is genuinely empty ──────────── */}
      {!loading && filteredEvents.length === 0 && !error && (
        <EmptyState
          icon="📅"
          title="Nothing scheduled this month"
          body="Approved leave, scheduled 1:1s, sprint deadlines, reminders, tasks with due dates, poll deadlines, birthdays and anniversaries all show up here."
        />
      )}
    </div>
  );
}

// ── Side panel: full list of events for a single selected day ─────
function DayDetailPanel({ dayIso, events, onClose }: {
  dayIso: string;
  events: Event[];
  onClose: () => void;
}) {
  const d = new Date(dayIso + "T00:00:00");
  const heading = d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

  return (
    <div className="flex flex-col max-h-[640px]">
      <div className="px-5 py-3 bg-[#FBFAFE] border-b border-[#E8E3ED] flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-[#737373] font-semibold">Day view</div>
          <div className="text-[14px] font-semibold text-[#0a0a0a] truncate">{heading}</div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close day view"
          className="w-7 h-7 rounded hover:bg-[#E8E3ED] text-[#737373] flex items-center justify-center text-[16px] flex-shrink-0"
        >
          ×
        </button>
      </div>
      {events.length === 0 ? (
        <div className="p-6 text-center text-[12.5px] text-[#a3a3a3]">
          Nothing on this day.
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto">
          {events.map((ev, i) => {
            const s = KIND_STYLE[ev.kind];
            return (
              <li
                key={i}
                className={`px-5 py-3 ${i !== events.length - 1 ? "border-b border-[#E8E3ED]" : ""}`}
              >
                <div className="flex items-start gap-2">
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0 mt-1.5" style={{ background: s.dot }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-0.5">
                      <span
                        className="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded"
                        style={{ background: s.bg, color: s.dot }}
                      >
                        {s.label}
                      </span>
                      {ev.time && <span className="text-[11px] font-mono text-[#525252]">{ev.time}</span>}
                      {ev.member_name && <span className="text-[11px] text-[#737373]">· {ev.member_name}</span>}
                    </div>
                    <div className="text-[13px] text-[#0a0a0a] leading-snug break-words">{ev.title}</div>
                    {ev.detail && (
                      <div className="text-[11.5px] text-[#737373] mt-0.5 break-words">
                        {ev.detail.startsWith("http") ? (
                          <a href={ev.detail} target="_blank" rel="noopener noreferrer" className="underline hover:text-[#0a0a0a]">
                            {ev.detail.length > 50 ? `${ev.detail.slice(0, 50)}…` : ev.detail}
                          </a>
                        ) : ev.detail}
                      </div>
                    )}
                    {ev.end && ev.end !== dayIso && (
                      <div className="text-[11px] text-[#737373] mt-0.5">until {fmtShortDate(ev.end)}</div>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────
function firstOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function firstGridDay(monthStart: Date): Date {
  // Walk back to the most recent Sunday on or before day 1.
  const d = new Date(monthStart);
  d.setDate(1);
  d.setDate(d.getDate() - d.getDay());
  return d;
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d); r.setDate(r.getDate() + n); return r;
}
function isoDate(d: Date): string {
  // Local date — not toISOString, which would shift across UTC midnight.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function fmtShortDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}
