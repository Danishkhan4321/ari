"use client";

// Home — two-column "Today's agenda" + "Ask Ari" / "Recent notes"
// section. Adapted for Ari's dashboard layout, but
// every row is real data from the user's account:
//   - Agenda merges today's reminders + tasks + meetings.
//   - "Ask Ari" jumps you into /chat (the dashboard's WhatsApp chat).
//   - "Recent notes" pulls the latest few notes from /api/notes/list.
import { useEffect, useState } from "react";

type Reminder = { id: number; message: string; reminder_time: string; status: string };
type Task     = { id: number; title: string; due_date: string | null; status: string };
type Meeting  = { id: number; title: string | null; start_time: string | null; status: string };
type Note     = { id: number; title: string | null; content: string; created_at: string; source: string | null };

type AgendaItem = {
  key: string;
  time: string;          // "09:00" or "—"
  ts: number;            // for sorting
  title: string;
  type: "Reminder" | "Task" | "Meeting";
  duration: string;
  color: string;
};

export function HomeAgenda() {
  const notes: Note[] = [];
  const [reminders, setReminders] = useState<Reminder[] | null>(null);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const j = (url: string) =>
      fetch(url, { cache: "no-store" })
        .then(r => r.ok ? r.json() : null)
        .catch(() => null);

    Promise.all([
      j("/api/reminders/list"),
      j("/api/tasks/list"),
      j("/api/meetings/list"),
    ]).then(([r, t, m]) => {
      if (cancelled) return;
      setReminders(((r?.reminders ?? r?.items ?? []) as Reminder[]).slice(0, 50));
      setTasks(((t?.tasks ?? t?.items ?? []) as Task[]).slice(0, 50));
      setMeetings(((m?.meetings ?? m?.items ?? []) as Meeting[]).slice(0, 50));
    });
    return () => { cancelled = true; };
  }, []);

  const agenda = buildAgenda(reminders, tasks, meetings);
  const loading = reminders === null && tasks === null && meetings === null;

  return (
    <div className="grid lg:grid-cols-[1.6fr,1fr] gap-5 mt-10">
      {/* Today's agenda */}
      <section className="dash-card-hero overflow-hidden">
        <div className="px-6 py-5 border-b border-[#0a0a0a]/15 flex items-center justify-between">
          <h2 className="dash-h2">Today&apos;s agenda</h2>
          <a href="/reminders" className="text-[12px] text-[#737373] hover:text-[#0a0a0a] transition-colors">
            View all
          </a>
        </div>
        {loading ? (
          <div className="px-6 py-10 text-center text-[13px] text-[#a3a3a3]">Loading…</div>
        ) : agenda.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <div className="text-[14px] font-medium mb-1">Nothing on today</div>
            <div className="text-[12.5px] text-[#737373]">
              Tell Ari on WhatsApp to add a reminder or task.
            </div>
          </div>
        ) : (
          <ul>
            {agenda.slice(0, 8).map((item, i) => (
              <li
                key={item.key}
                className={`flex items-center gap-5 px-6 py-4 hover:bg-[#FBFAFE] transition-colors group ${
                  i !== Math.min(agenda.length, 8) - 1 ? "border-b border-[#E8E3ED]" : ""
                }`}
              >
                <div className="num text-[12px] text-[#737373] w-12 flex-shrink-0 font-medium">
                  {item.time}
                </div>
                <span
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ background: item.color }}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-[13.5px] font-medium text-[#0a0a0a] truncate">{item.title}</div>
                  <div className="text-[11.5px] text-[#737373] mt-1">
                    {item.type} · {item.duration}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Right column */}
      <div className="space-y-5">
        {/* Ask Ari — jumps to /chat */}
        <section
          className="bg-[#0E0E0C] text-white p-5 border border-[#0a0a0a]"
          style={{ borderRadius: 12, boxShadow: "4px 4px 0 #0a0a0a" }}
        >
          <div className="flex items-center justify-between mb-4">
            <h3 className="dash-h2 text-white flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-[#8A65FF] animate-pulse" />
              Ask Ari
            </h3>
            <span className="text-[10px] text-white/55 uppercase tracking-wider">⌘ K</span>
          </div>
          <a
            href="/chat"
            className="block w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2.5 text-[13px] text-white/60 hover:text-white hover:border-[#8A65FF] transition-colors"
          >
            Remind me to call mom at 6 PM…
          </a>
          <div className="flex flex-wrap gap-1.5 mt-3.5">
            {[
              { label: "Reminder",  color: "#8A65FF", href: "/reminders" },
              { label: "Task",      color: "#D8CCFF", href: "/tasks" },
              { label: "Contact",   color: "#D8CCFF", href: "/contacts" },
            ].map((q) => (
              <a
                key={q.label}
                href={q.href}
                className="text-[11px] font-medium text-white/80 bg-white/5 border border-white/15 hover:bg-white/10 hover:border-white/30 px-2.5 py-1 rounded inline-flex items-center gap-1.5 transition-colors"
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: q.color }} />
                {q.label}
              </a>
            ))}
          </div>
        </section>

        {/* Notes are intentionally hidden while the feature is out of navigation. */}
        {false && (
        <section className="dash-card overflow-hidden">
          <div className="px-5 py-4 border-b border-[#E8E3ED] flex items-center justify-between">
            <h3 className="dash-h2">Recent notes</h3>
            <a href="/notes" className="text-[11px] text-[#737373] hover:text-[#0a0a0a]">View all</a>
          </div>
          {notes === null ? (
            <div className="px-5 py-6 text-[12.5px] text-[#a3a3a3]">Loading…</div>
          ) : notes.length === 0 ? (
            <div className="px-5 py-6 text-[12.5px] text-[#737373]">
              No notes yet. Send Ari a note on WhatsApp to start one.
            </div>
          ) : (
            <ul>
              {notes.map((n, i) => (
                <li
                  key={n.id}
                  className={`px-5 py-4 hover:bg-[#FBFAFE] cursor-default transition-colors ${
                    i !== notes.length - 1 ? "border-b border-[#E8E3ED]" : ""
                  }`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[10px] font-medium text-[#737373] uppercase tracking-wider">
                      {n.source || "Note"}
                    </span>
                    <span className="w-1 h-1 rounded-full bg-[#d4d4d4]" />
                    <span className="text-[11px] text-[#a3a3a3]">{relativeTime(n.created_at)}</span>
                  </div>
                  <div className="text-[12.5px] leading-relaxed text-[#404040] line-clamp-2">
                    {n.title ? <span className="font-medium text-[#0a0a0a]">{n.title}: </span> : null}
                    {n.content}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        )}
      </div>
    </div>
  );
}

// Build a unified agenda for "today" — picks rows whose time falls
// within the next ~24h. Items without a time are sorted last.
function buildAgenda(
  reminders: Reminder[] | null,
  tasks: Task[] | null,
  meetings: Meeting[] | null,
): AgendaItem[] {
  const out: AgendaItem[] = [];
  const now = Date.now();
  const horizon = now + 24 * 60 * 60 * 1000; // next 24h

  for (const r of reminders ?? []) {
    if (r.status === "completed" || r.status === "cancelled") continue;
    const t = parseTs(r.reminder_time);
    if (t === null || t > horizon) continue;
    out.push({
      key: `r-${r.id}`,
      time: fmtTime(t),
      ts: t,
      title: r.message,
      type: "Reminder",
      duration: t < now ? "overdue" : relativeTime(new Date(t).toISOString()),
      color: "#3FAA6E",
    });
  }
  for (const tk of tasks ?? []) {
    if (tk.status === "completed" || tk.status === "done") continue;
    const t = parseTs(tk.due_date);
    if (t !== null && t > horizon) continue;
    out.push({
      key: `t-${tk.id}`,
      time: t === null ? "—" : fmtTime(t),
      ts: t ?? Number.MAX_SAFE_INTEGER,
      title: tk.title,
      type: "Task",
      duration: t === null ? "due any time" : t < now ? "overdue" : "due today",
      color: "#F59E0B",
    });
  }
  for (const m of meetings ?? []) {
    const t = parseTs(m.start_time);
    if (t === null || t > horizon) continue;
    out.push({
      key: `m-${m.id}`,
      time: fmtTime(t),
      ts: t,
      title: m.title || "(untitled meeting)",
      type: "Meeting",
      duration: t < now ? "in progress / done" : relativeTime(new Date(t).toISOString()),
      color: "#6366F1",
    });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function parseTs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}
function fmtTime(t: number): string {
  const d = new Date(t);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${String(h).padStart(2, "0")}:${m}`;
}
function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = t - Date.now();
  const abs = Math.abs(diff);
  const future = diff > 0;
  const mins = Math.round(abs / 60_000);
  if (mins < 60) return future ? `in ${mins}m` : `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return future ? `in ${hrs}h` : `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return future ? `in ${days}d` : `${days}d ago`;
}
