"use client";

// Pending widget — shows above the Today tab content. The "things
// waiting on you" stack: sprint items in progress, upcoming 1:1s,
// today's standup if missing, leave to approve, incidents assigned.
//
// Doesn't render at all if there's nothing pending. The Linear-Inbox
// pattern compressed: one block answering "what blocks others?".
import { useEffect, useState } from "react";

type SprintItem = { id: number; title: string; story_points: number; status: string };
type OneOnOne = { id: number; partner_name: string; role: string; next_at: string; agenda: string | null };
type Leave = {
  id: number; employee_name: string | null; employee_phone: string;
  leave_type: string; start_date: string; end_date: string;
};
type Incident = { id: number; title: string; severity: string };

type Payload = {
  total_count: number;
  sprint_items: SprintItem[];
  one_on_ones: OneOnOne[];
  standup_needed: { config_id: number } | null;
  pending_leaves: Leave[];
  open_incidents: Incident[];
};

export function PendingWidget({ teamName }: { teamName: string }) {
  const [data, setData] = useState<Payload | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/team/${encodeURIComponent(teamName)}/pending`, { cache: "no-store" })
      .then(r => r.json())
      .then((d: { ok: boolean } & Payload) => {
        if (!cancelled && d.ok) setData(d);
      })
      .catch(() => { /* silent — widget just doesn't render */ });
    return () => { cancelled = true; };
  }, [teamName]);

  if (!data || data.total_count === 0) return null;

  return (
    <section className="dash-card-hero p-5 mb-5">
      <div className="dash-label mb-3 flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-[#6E49E8]" />
        Waiting on you · {data.total_count}
      </div>

      <ul className="space-y-2">
        {data.standup_needed && (
          <li className="flex items-start gap-3 px-3 py-2 bg-white border border-[#E8E3ED] rounded-md">
            <span className="text-[14px] mt-0.5">📋</span>
            <div className="flex-1 text-[13.5px]">
              <span className="font-medium">Submit your standup for today</span>
              <div className="text-[11.5px] text-[#737373] mt-0.5">
                Text Ari: <span className="font-mono">standup yesterday: X · today: Y · blockers: none</span>
              </div>
            </div>
          </li>
        )}

        {data.one_on_ones.map(o => (
          <li key={`oo-${o.id}`} className="flex items-start gap-3 px-3 py-2 bg-white border border-[#E8E3ED] rounded-md">
            <span className="text-[14px] mt-0.5">🗓️</span>
            <div className="flex-1 text-[13.5px]">
              <span className="font-medium">1:1 with {o.partner_name}</span>
              <span className="text-[#737373] ml-2">{fmtSoon(o.next_at)}</span>
              {o.agenda && (
                <div className="text-[11.5px] text-[#737373] mt-0.5 truncate">Agenda: {o.agenda}</div>
              )}
            </div>
          </li>
        ))}

        {data.sprint_items.map(it => (
          <li key={`si-${it.id}`} className="flex items-start gap-3 px-3 py-2 bg-white border border-[#E8E3ED] rounded-md">
            <span
              className="w-3.5 h-3.5 rounded-full border mt-1 flex-shrink-0"
              style={{
                background: it.status === "in_progress" ? "#8A65FF" : it.status === "blocked" ? "#ef444433" : "transparent",
                borderColor: it.status === "blocked" ? "#ef4444" : it.status === "in_progress" ? "#8A65FF" : "#a3a3a3",
              }}
            />
            <div className="flex-1 text-[13.5px]">
              <span className="break-words">{it.title}</span>
              <span className="text-[11px] text-[#737373] ml-2 font-mono">
                {it.story_points} pt{it.story_points === 1 ? "" : "s"} · {it.status.replace("_", " ")}
              </span>
            </div>
          </li>
        ))}

        {data.pending_leaves.map(l => (
          <li key={`lv-${l.id}`} className="flex items-start gap-3 px-3 py-2 bg-white border border-[#E8E3ED] rounded-md">
            <span className="text-[14px] mt-0.5">🌴</span>
            <div className="flex-1 text-[13.5px]">
              <span className="font-medium">{l.employee_name || `+${l.employee_phone}`}</span>
              {" "}requested {l.leave_type} leave
              <div className="text-[11.5px] text-[#737373] mt-0.5">
                {fmtRange(l.start_date, l.end_date)} · awaiting your approval
              </div>
            </div>
          </li>
        ))}

        {data.open_incidents.map(it => (
          <li key={`in-${it.id}`} className="flex items-start gap-3 px-3 py-2 bg-white border border-[#E8E3ED] rounded-md">
            <span
              className="w-2 h-2 rounded-full mt-2 flex-shrink-0"
              style={{ background: it.severity === "critical" ? "#ef4444" : it.severity === "high" ? "#F59E0B" : "#8A65FF" }}
            />
            <div className="flex-1 text-[13.5px]">
              <span className="break-words">{it.title}</span>
              <span className="text-[11px] text-[#737373] ml-2">{it.severity} incident</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function fmtSoon(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diffHours = Math.round((t - Date.now()) / 3_600_000);
  if (diffHours <= 0) return "starting now";
  if (diffHours < 24) return `in ${diffHours}h`;
  return new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
}
function fmtRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const sf = s.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const ef = e.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return start === end ? sf : `${sf} → ${ef}`;
}
