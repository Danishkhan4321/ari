// dashboard/lib/team-calendar.ts
//
// Aggregates "what's happening on the team" across leave, sprint
// deadlines, 1:1s, birthdays, anniversaries, reminders, tasks with
// due dates, poll deadlines, and past meetings. Returns a flat
// sorted timeline that the UI buckets into days.
//
// May 10 2026 — expanded from 6 to 9 event kinds and rebuilt as a
// Google-Calendar-style month grid in the UI. Removed the broken
// `meeting_aws_instances.scheduled_for` query (column never existed)
// and replaced with `launched_at` so past meetings still appear.
import { query } from "@/lib/db";

export type CalendarEventKind =
  | "leave"
  | "meeting"
  | "sprint_end"
  | "one_on_one"
  | "birthday"
  | "anniversary"
  | "reminder"
  | "task"
  | "poll";

export type CalendarEvent = {
  kind: CalendarEventKind;
  start: string;            // ISO 8601 — date or datetime
  end: string | null;       // ISO 8601 date for spans, null for points
  member_phone: string | null;
  member_name: string | null;
  title: string;
  detail: string | null;
  // Optional: time-of-day for the event (HH:MM in user's tz). Null = all-day.
  time: string | null;
};

export async function getTeamCalendar(
  adminPhone: string,
  memberPhones: string[],
  teamName: string,
  fromIso: string, // YYYY-MM-DD
  toIso: string
): Promise<CalendarEvent[]> {
  const out: CalendarEvent[] = [];

  // Build a phone → name map once so individual sources can attach a name
  // even when their own join would be expensive or duplicate-prone.
  const nameByPhone = new Map<string, string>();
  try {
    const r = await query<{ member_phone: string; member_name: string | null }>(
      `SELECT member_phone, member_name FROM teams WHERE admin_phone = $1 AND team_name = $2`,
      [adminPhone, teamName.toLowerCase()]
    );
    for (const row of r.rows) {
      if (row.member_name) nameByPhone.set(row.member_phone, row.member_name);
    }
  } catch { /* fall through with empty map */ }
  const nameOf = (phone: string | null): string | null =>
    phone ? (nameByPhone.get(phone) || null) : null;
  const labelOf = (phone: string | null, name: string | null): string => {
    const resolved = name || nameOf(phone);
    if (resolved) return resolved;
    if (phone) return `+${phone}`;
    return "Someone";
  };

  // ── Leave (approved + active in window) ────────────────────────────
  if (memberPhones.length > 0) {
    try {
      const r = await query<{ employee_phone: string; start_date: string; end_date: string; leave_type: string; reason: string | null }>(
        `SELECT employee_phone, start_date::text, end_date::text, leave_type, reason
           FROM leave_requests
          WHERE status = 'approved'
            AND employee_phone = ANY($1::text[])
            AND start_date <= $3::date
            AND end_date   >= $2::date`,
        [memberPhones, fromIso, toIso]
      );
      for (const x of r.rows) {
        const name = nameOf(x.employee_phone);
        out.push({
          kind: "leave",
          start: x.start_date, end: x.end_date,
          member_phone: x.employee_phone, member_name: name,
          title: `${labelOf(x.employee_phone, name)} on ${x.leave_type} leave`,
          detail: x.reason,
          time: null,
        });
      }
    } catch { /* swallow */ }
  }

  // ── Past meetings (recordings) ─────────────────────────────────────
  // Used to query meeting_aws_instances.scheduled_for which never
  // existed — the catch silently swallowed every fetch. Now uses
  // `launched_at` so past meetings actually appear on the timeline.
  if (memberPhones.length > 0) {
    try {
      const r = await query<{ user_phone: string; meeting_url: string; launched_at: string; status: string; platform: string | null }>(
        `SELECT user_phone, meeting_url, launched_at, status, platform
           FROM meeting_aws_instances
          WHERE user_phone = ANY($1::text[])
            AND launched_at IS NOT NULL
            AND launched_at >= $2::date
            AND launched_at <  $3::date + INTERVAL '1 day'`,
        [memberPhones, fromIso, toIso]
      );
      for (const x of r.rows) {
        const launched = new Date(x.launched_at);
        const time = `${pad(launched.getHours())}:${pad(launched.getMinutes())}`;
        const platform = (x.platform || "Meeting").replace(/_/g, " ");
        out.push({
          kind: "meeting",
          start: launched.toISOString(),
          end: null,
          member_phone: x.user_phone,
          member_name: nameOf(x.user_phone),
          title: `${platform} • ${labelOf(x.user_phone, null)}`,
          detail: x.meeting_url,
          time,
        });
      }
    } catch { /* swallow if table missing */ }
  }

  // ── Sprint end_date ────────────────────────────────────────────────
  try {
    const r = await query<{ id: number; name: string; end_date: string | null }>(
      `SELECT id, name, end_date::text
         FROM sprints
        WHERE team_admin_phone = $1
          AND status = 'active'
          AND end_date BETWEEN $2::date AND $3::date`,
      [adminPhone, fromIso, toIso]
    );
    for (const x of r.rows) {
      if (!x.end_date) continue;
      out.push({
        kind: "sprint_end",
        start: x.end_date, end: null,
        member_phone: null, member_name: null,
        title: `Sprint ends: ${x.name}`,
        detail: null,
        time: null,
      });
    }
  } catch { /* swallow */ }

  // ── 1:1s ───────────────────────────────────────────────────────────
  try {
    const r = await query<{ next_at: string; manager_name: string | null; report_name: string | null; manager_phone: string; report_phone: string; agenda: string | null }>(
      `SELECT next_at, manager_name, report_name, manager_phone, report_phone, agenda
         FROM one_on_ones
        WHERE admin_phone = $1
          AND next_at >= $2::date
          AND next_at <  $3::date + INTERVAL '1 day'`,
      [adminPhone, fromIso, toIso]
    );
    for (const x of r.rows) {
      const at = new Date(x.next_at);
      const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
      out.push({
        kind: "one_on_one",
        start: at.toISOString(), end: null,
        member_phone: x.report_phone, member_name: x.report_name || nameOf(x.report_phone),
        title: `1:1 — ${x.manager_name || labelOf(x.manager_phone, null)} ↔ ${x.report_name || labelOf(x.report_phone, null)}`,
        detail: x.agenda,
        time,
      });
    }
  } catch { /* swallow if table missing */ }

  // ── Birthdays + anniversaries ──────────────────────────────────────
  try {
    const r = await query<{ member_phone: string; birthday: string | null; joined_at: string | null }>(
      `SELECT member_phone, birthday::text, joined_at::text
         FROM team_member_meta
        WHERE admin_phone = $1
          AND team_name   = $2`,
      [adminPhone, teamName.toLowerCase()]
    );
    const start = new Date(fromIso);
    const end   = new Date(toIso);
    for (const x of r.rows) {
      const name = nameOf(x.member_phone);
      if (x.birthday) {
        const d = anniversaryInWindow(x.birthday, start, end);
        if (d) out.push({
          kind: "birthday",
          start: d.toISOString().slice(0, 10), end: null,
          member_phone: x.member_phone, member_name: name,
          title: `🎂 ${labelOf(x.member_phone, name)}'s birthday`,
          detail: null,
          time: null,
        });
      }
      if (x.joined_at) {
        const d = anniversaryInWindow(x.joined_at, start, end);
        if (d && d.getFullYear() > new Date(x.joined_at).getFullYear()) {
          const years = d.getFullYear() - new Date(x.joined_at).getFullYear();
          out.push({
            kind: "anniversary",
            start: d.toISOString().slice(0, 10), end: null,
            member_phone: x.member_phone, member_name: name,
            title: `🎉 ${labelOf(x.member_phone, name)}'s ${years}-year anniversary`,
            detail: null,
            time: null,
          });
        }
      }
    }
  } catch { /* swallow if table missing */ }

  // ── Reminders (pending + scheduled inside window) ──────────────────
  // Schema: reminders.reminder_time TIMESTAMP WITH TIME ZONE, status
  // typically 'pending' for unfired ones. We include both pending and
  // sent so the user can also see "what fired today" on the calendar.
  if (memberPhones.length > 0) {
    try {
      const r = await query<{ id: number; user_phone: string; message: string; reminder_time: string; status: string }>(
        `SELECT id, user_phone, message, reminder_time, status
           FROM reminders
          WHERE user_phone = ANY($1::text[])
            AND status IN ('pending', 'sent', 'completed')
            AND reminder_time >= $2::date
            AND reminder_time <  $3::date + INTERVAL '1 day'
          LIMIT 500`,
        [memberPhones, fromIso, toIso]
      );
      for (const x of r.rows) {
        const at = new Date(x.reminder_time);
        const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
        const name = nameOf(x.user_phone);
        out.push({
          kind: "reminder",
          start: at.toISOString(), end: null,
          member_phone: x.user_phone, member_name: name,
          title: x.message.slice(0, 80),
          detail: name ? `For ${name}` : null,
          time,
        });
      }
    } catch { /* swallow */ }
  }

  // ── Tasks with due dates ───────────────────────────────────────────
  if (memberPhones.length > 0) {
    try {
      const r = await query<{ id: number; user_phone: string; assigned_to: string | null; description: string; due_date: string; status: string; priority: string | null }>(
        `SELECT id, user_phone, assigned_to, description, due_date, status, priority
           FROM tasks
          WHERE (user_phone = ANY($1::text[]) OR assigned_to = ANY($1::text[]))
            AND due_date IS NOT NULL
            AND due_date >= $2::date
            AND due_date <  $3::date + INTERVAL '1 day'
            AND status NOT IN ('completed', 'cancelled')
          LIMIT 500`,
        [memberPhones, fromIso, toIso]
      );
      for (const x of r.rows) {
        const due = new Date(x.due_date);
        const owner = x.assigned_to || x.user_phone;
        const name = nameOf(owner);
        const time = (due.getHours() === 0 && due.getMinutes() === 0)
          ? null
          : `${pad(due.getHours())}:${pad(due.getMinutes())}`;
        out.push({
          kind: "task",
          start: due.toISOString(), end: null,
          member_phone: owner, member_name: name,
          title: x.description.slice(0, 80),
          detail: [x.priority ? `${x.priority} priority` : null, name ? `Owner: ${name}` : null].filter(Boolean).join(" · ") || null,
          time,
        });
      }
    } catch { /* swallow */ }
  }

  // ── Poll deadlines (active polls only) ─────────────────────────────
  if (memberPhones.length > 0) {
    try {
      const r = await query<{ id: number; question: string; deadline: string | null; status: string; creator_phone: string }>(
        `SELECT id, question, deadline, status, creator_phone
           FROM polls
          WHERE creator_phone = ANY($1::text[])
            AND deadline IS NOT NULL
            AND deadline >= $2::date
            AND deadline <  $3::date + INTERVAL '1 day'
            AND status = 'active'
          LIMIT 200`,
        [memberPhones, fromIso, toIso]
      );
      for (const x of r.rows) {
        if (!x.deadline) continue;
        const at = new Date(x.deadline);
        const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
        out.push({
          kind: "poll",
          start: at.toISOString(), end: null,
          member_phone: x.creator_phone, member_name: nameOf(x.creator_phone),
          title: `Poll closes: ${x.question.slice(0, 60)}`,
          detail: null,
          time,
        });
      }
    } catch { /* swallow */ }
  }

  // Sort chronologically — full ISO compare is correct for both date
  // and datetime strings since lexical order matches chronological order.
  out.sort((a, b) => a.start.localeCompare(b.start));
  return out;
}

// Returns the same-month-day date that falls inside the [from, to]
// window, or null. Used to project annual events (birthdays,
// anniversaries) onto the visible calendar window.
function anniversaryInWindow(dateStr: string, from: Date, to: Date): Date | null {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  for (let y = from.getUTCFullYear(); y <= to.getUTCFullYear(); y++) {
    const c = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate()));
    if (c >= from && c <= to) return c;
  }
  return null;
}

function pad(n: number): string { return n < 10 ? `0${n}` : String(n); }
