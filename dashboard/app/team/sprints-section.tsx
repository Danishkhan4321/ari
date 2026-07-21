"use client";

// Sprints — fetches the active sprint + history + velocity for one
// team, renders a hero card with progress, a per-status item list,
// and a small history table. Members can flip item status; only the
// admin can start a sprint, end it, or delete items.
//
// Mounted by team-content.tsx when the "Sprints" tab is active.
import { useEffect, useState } from "react";
import { EmptyState } from "@/components/dash-page";
import { AiPlanModal } from "./ai-plan-modal";

type Sprint = {
  id: number;
  team_admin_phone: string;
  name: string;
  start_date: string;
  end_date: string | null;
  goal: string | null;
  status: string;
  created_at: string;
};

type SprintItem = {
  id: number;
  sprint_id: number;
  title: string;
  description: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  story_points: number;
  status: "todo" | "in_progress" | "done" | "blocked" | string;
  created_at: string;
  completed_at: string | null;
};

type SprintStats = {
  totalItems: number;
  totalPoints: number;
  completedItems: number;
  completedPoints: number;
  inProgressItems: number;
  blockedItems: number;
  progressPercent: number;
  daysRemaining: number | null;
  daysTotal: number | null;
};

type HistoryRow = {
  id: number;
  name: string;
  goal: string | null;
  start_date: string;
  end_date: string | null;
  total_items: number;
  total_points: number;
  completed_items: number;
  completed_points: number;
  created_at: string;
};

type Velocity = { avgVelocity: number; sprints: { name: string; points: number }[] };

type Payload = {
  ok: boolean;
  is_admin: boolean;
  active: { sprint: Sprint; items: SprintItem[]; stats: SprintStats } | null;
  history: HistoryRow[];
  velocity: Velocity;
};

type Member = { member_phone: string; member_name: string | null };

export function SprintsSection({
  teamName,
  isAdmin,
  members,
}: {
  teamName: string;
  isAdmin: boolean;
  members: Member[];
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [aiPlanOpen, setAiPlanOpen] = useState(false);
  const [addItemOpen, setAddItemOpen] = useState(false);

  async function refresh() {
    setBusy(true);
    try {
      const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/sprints`, { cache: "no-store" });
      const d = (await r.json()) as Payload;
      if (!d.ok) {
        setError((d as unknown as { error?: string }).error || "Could not load sprints.");
        setData({ ok: false, is_admin: isAdmin, active: null, history: [], velocity: { avgVelocity: 0, sprints: [] } });
      } else {
        setData(d);
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [teamName]);

  if (data === null) {
    return <div className="dash-card p-10 text-center text-[13px] text-[#a3a3a3]">Loading sprints…</div>;
  }

  return (
    <div className="space-y-5">
      {error && (
        <div className="dash-card bg-[#FFB1D8]/30 border border-[#FFB1D8] px-4 py-3 text-sm">
          ⚠️ {error} <button onClick={() => setError(null)} className="ml-2 text-[#737373] hover:text-black">×</button>
        </div>
      )}

      {data.active ? (
        <ActiveSprint
          sprint={data.active.sprint}
          items={data.active.items}
          stats={data.active.stats}
          velocity={data.velocity}
          isAdmin={isAdmin}
          teamName={teamName}
          onChange={refresh}
          onAddItem={() => setAddItemOpen(true)}
          setError={setError}
          busy={busy}
        />
      ) : (
        <EmptyState
          icon="🏁"
          title="No active sprint"
          body={
            isAdmin
              ? "Start a sprint manually, or describe what you want to ship and Ari will plan it for you."
              : `Ask the admin to start a sprint, or text Ari: "start sprint Q2 release for ${teamName}".`
          }
          cta={
            isAdmin && (
              <div className="flex items-center gap-2 justify-center flex-wrap">
                <button onClick={() => setAiPlanOpen(true)} className="dash-btn dash-btn-primary">
                  ✨ Plan with AI
                </button>
                <button onClick={() => setStartOpen(true)} className="dash-btn">
                  + Start manually
                </button>
              </div>
            )
          }
        />
      )}

      {data.history.length > 0 && (
        <HistoryTable history={data.history} velocity={data.velocity} />
      )}

      {isAdmin && (
        <StartSprintModal
          open={startOpen}
          onClose={() => setStartOpen(false)}
          teamName={teamName}
          onStarted={() => { setStartOpen(false); void refresh(); }}
        />
      )}

      {isAdmin && (
        <AiPlanModal
          open={aiPlanOpen}
          onClose={() => setAiPlanOpen(false)}
          teamName={teamName}
          members={members}
          onCreated={() => { setAiPlanOpen(false); void refresh(); }}
        />
      )}

      {data.active && (
        <AddItemModal
          open={addItemOpen}
          onClose={() => setAddItemOpen(false)}
          teamName={teamName}
          members={members}
          onAdded={() => { setAddItemOpen(false); void refresh(); }}
        />
      )}
    </div>
  );
}

// ─── Active sprint card + items ────────────────────────────────────────

function ActiveSprint({
  sprint, items, stats, velocity, isAdmin, teamName, onChange, onAddItem, setError, busy,
}: {
  sprint: Sprint;
  items: SprintItem[];
  stats: SprintStats;
  velocity: Velocity;
  isAdmin: boolean;
  teamName: string;
  onChange: () => void;
  onAddItem: () => void;
  setError: (s: string | null) => void;
  busy: boolean;
}) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [endingSprint, setEndingSprint] = useState(false);

  async function patchStatus(itemId: number, status: SprintItem["status"]) {
    setBusyId(itemId);
    try {
      const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/sprints/items/${itemId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const d = await r.json();
      if (!d.ok) setError(d.error || "Could not update.");
      else onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function deleteItem(itemId: number) {
    if (!confirm("Delete this item?")) return;
    setBusyId(itemId);
    try {
      const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/sprints/items/${itemId}`, {
        method: "DELETE",
      });
      const d = await r.json();
      if (!d.ok) setError(d.error || "Could not delete.");
      else onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function endSprint() {
    if (!confirm(`End sprint "${sprint.name}"? You can start a new one right after.`)) return;
    setEndingSprint(true);
    try {
      const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/sprints/end`, { method: "POST" });
      const d = await r.json();
      if (!d.ok) setError(d.error || "Could not end sprint.");
      else onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setEndingSprint(false);
    }
  }

  // Group items by status for display
  const groups: { key: SprintItem["status"]; label: string; color: string }[] = [
    { key: "in_progress", label: "In progress", color: "#8A65FF" },
    { key: "todo", label: "To do", color: "#a3a3a3" },
    { key: "blocked", label: "Blocked", color: "#ef4444" },
    { key: "done", label: "Done", color: "#3FAA6E" },
  ];

  return (
    <>
      {/* Hero */}
      <section className="dash-card-hero p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
          <div className="min-w-0">
            <div className="dash-label mb-2 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-[#D8CCFF]" />
              Active sprint
              {stats.daysRemaining !== null && (
                <span className="text-[#737373] ml-1">
                  · {stats.daysRemaining === 0 ? "ends today" : `${stats.daysRemaining}d left`}
                </span>
              )}
            </div>
            <h2 className="dash-h1 text-[22px] break-words">{sprint.name}</h2>
            {sprint.goal && (
              <p className="text-[13.5px] text-[#525252] mt-2 leading-relaxed max-w-xl break-words">
                {sprint.goal}
              </p>
            )}
            <div className="text-[11.5px] text-[#737373] mt-2 flex items-center gap-2 flex-wrap">
              <span>Started {fmtDate(sprint.start_date)}</span>
              {sprint.end_date && (
                <>
                  <span className="w-1 h-1 rounded-full bg-[#d4d4d4]" />
                  <span>Ends {fmtDate(sprint.end_date)}</span>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={onAddItem}
              disabled={busy}
              className="dash-btn"
            >
              + Add item
            </button>
            {isAdmin && (
              <button
                onClick={endSprint}
                disabled={endingSprint}
                className="dash-btn disabled:opacity-50"
              >
                {endingSprint ? "Ending…" : "End sprint"}
              </button>
            )}
          </div>
        </div>

        {/* Progress bar */}
        <div>
          <div className="flex items-center justify-between text-[11.5px] text-[#737373] mb-1.5">
            <span>{stats.completedPoints} of {stats.totalPoints} points done</span>
            <span className="num font-semibold text-[#0a0a0a]">{stats.progressPercent}%</span>
          </div>
          <div className="h-2 rounded-full bg-[#E8E3ED] overflow-hidden">
            <div
              className="h-full bg-[#3FAA6E] transition-all"
              style={{ width: `${stats.progressPercent}%` }}
            />
          </div>
        </div>

        {/* Stat tiles */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mt-5">
          <Stat label="Items" value={`${stats.completedItems}/${stats.totalItems}`} />
          <Stat label="In progress" value={String(stats.inProgressItems)} />
          <Stat label="Blocked" value={String(stats.blockedItems)} accent={stats.blockedItems > 0 ? "#ef4444" : undefined} />
          <Stat
            label={velocity.sprints.length > 0 ? `Velocity (avg ${velocity.sprints.length})` : "Velocity"}
            value={velocity.avgVelocity > 0 ? `${velocity.avgVelocity} pts` : "—"}
          />
        </div>
      </section>

      {/* Items grouped by status */}
      <section className="dash-card overflow-hidden">
        <div className="px-5 py-4 border-b border-[#E8E3ED] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#8A65FF]" />
            <h3 className="dash-h2">Items</h3>
          </div>
          <span className="text-[11px] text-[#737373]">{items.length} total</span>
        </div>
        {items.length === 0 ? (
          <div className="px-5 py-10 text-center text-[13px] text-[#737373]">
            No items yet. Click <span className="font-mono">+ Add item</span> above, or text Ari:{" "}
            <span className="font-mono">add to sprint: ship onboarding flow @priya 5pts</span>.
          </div>
        ) : (
          <div className="divide-y divide-[#E8E3ED]">
            {groups.map(g => {
              const inGroup = items.filter(i => i.status === g.key);
              if (inGroup.length === 0) return null;
              return (
                <div key={g.key}>
                  <div className="px-5 py-2 bg-[#FBFAFE] text-[10.5px] uppercase tracking-wider font-semibold text-[#737373] flex items-center gap-2 border-b border-[#E8E3ED]">
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: g.color }} />
                    {g.label}
                    <span className="num text-[#a3a3a3] font-normal">{inGroup.length}</span>
                  </div>
                  <ul>
                    {inGroup.map((it, idx, arr) => (
                      <li
                        key={it.id}
                        className={`px-5 py-3 hover:bg-[#FBFAFE] transition-colors group ${idx !== arr.length - 1 ? "border-b border-[#E8E3ED]" : ""}`}
                      >
                        <div className="flex items-start gap-3">
                          {/* Status toggle (click cycles through todo → in_progress → done) */}
                          <button
                            onClick={() => patchStatus(it.id, nextStatus(it.status))}
                            disabled={busyId === it.id}
                            title="Click to change status"
                            className={`mt-0.5 w-4 h-4 rounded-full border flex-shrink-0 flex items-center justify-center transition-all ${
                              it.status === "done"
                                ? "bg-[#3FAA6E] border-[#3FAA6E]"
                                : it.status === "in_progress"
                                ? "border-[#8A65FF] bg-[#8A65FF]/30"
                                : it.status === "blocked"
                                ? "border-[#ef4444] bg-[#ef4444]/20"
                                : "border-[#a3a3a3] hover:border-[#0a0a0a]"
                            }`}
                          >
                            {it.status === "done" && (
                              <svg width="9" height="9" viewBox="0 0 16 16" fill="none">
                                <path d="M3 8.5l3 3 7-7" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            )}
                          </button>
                          <div className="flex-1 min-w-0">
                            <div className={`text-[13.5px] break-words leading-snug ${it.status === "done" ? "line-through text-[#a3a3a3]" : "text-[#0a0a0a]"}`}>
                              {it.title}
                            </div>
                            <div className="text-[11.5px] text-[#737373] mt-1 flex items-center gap-2 flex-wrap">
                              {it.assigned_to_name && (
                                <span className="inline-flex items-center gap-1">
                                  <span className="w-3.5 h-3.5 rounded-full bg-[#6E49E8] border border-[#0a0a0a] text-[8.5px] flex items-center justify-center font-bold text-[#0a0a0a]">
                                    {it.assigned_to_name.charAt(0).toUpperCase()}
                                  </span>
                                  {it.assigned_to_name}
                                </span>
                              )}
                              <span className="font-mono">{it.story_points} {it.story_points === 1 ? "pt" : "pts"}</span>
                              {it.completed_at && (
                                <span>· done {fmtAgo(it.completed_at)}</span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <select
                              value={it.status}
                              onChange={(e) => patchStatus(it.id, e.target.value as SprintItem["status"])}
                              disabled={busyId === it.id}
                              className="dash-input !text-[11px] !py-0.5 !px-1.5 cursor-pointer"
                            >
                              <option value="todo">To do</option>
                              <option value="in_progress">In progress</option>
                              <option value="blocked">Blocked</option>
                              <option value="done">Done</option>
                            </select>
                            {isAdmin && (
                              <button
                                onClick={() => deleteItem(it.id)}
                                disabled={busyId === it.id}
                                className="opacity-0 group-hover:opacity-100 text-[#a3a3a3] hover:text-[#ef4444] px-2 transition-opacity disabled:opacity-50"
                                aria-label="Delete"
                              >
                                ×
                              </button>
                            )}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}

// ─── History table ─────────────────────────────────────────────────────

function HistoryTable({ history, velocity }: { history: HistoryRow[]; velocity: Velocity }) {
  return (
    <section className="dash-card overflow-hidden">
      <div className="px-5 py-4 border-b border-[#E8E3ED] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-[#a3a3a3]" />
          <h3 className="dash-h2">Past sprints</h3>
        </div>
        {velocity.avgVelocity > 0 && (
          <span className="text-[11px] text-[#737373]">
            Avg <span className="num font-semibold text-[#0a0a0a]">{velocity.avgVelocity}</span> pts/sprint
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[10.5px] uppercase tracking-wider text-[#737373] bg-[#FBFAFE] border-b border-[#E8E3ED]">
              <th className="px-5 py-2 font-semibold">Sprint</th>
              <th className="px-3 py-2 font-semibold">Items</th>
              <th className="px-3 py-2 font-semibold">Points</th>
              <th className="px-3 py-2 font-semibold">Completion</th>
              <th className="px-5 py-2 font-semibold">Range</th>
            </tr>
          </thead>
          <tbody>
            {history.map((s, i, arr) => {
              const pct = s.total_points > 0 ? Math.round((s.completed_points / s.total_points) * 100) : 0;
              return (
                <tr
                  key={s.id}
                  className={`hover:bg-[#FBFAFE] transition-colors ${i !== arr.length - 1 ? "border-b border-[#E8E3ED]" : ""}`}
                >
                  <td className="px-5 py-3">
                    <div className="font-medium truncate max-w-[260px]">{s.name}</div>
                    {s.goal && <div className="text-[11.5px] text-[#737373] truncate max-w-[260px]">{s.goal}</div>}
                  </td>
                  <td className="px-3 py-3 num">{s.completed_items}/{s.total_items}</td>
                  <td className="px-3 py-3 num">{s.completed_points}/{s.total_points}</td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-1.5 rounded-full bg-[#E8E3ED] overflow-hidden">
                        <div
                          className="h-full"
                          style={{
                            width: `${pct}%`,
                            background: pct >= 80 ? "#3FAA6E" : pct >= 50 ? "#D8CCFF" : "#ef4444",
                          }}
                        />
                      </div>
                      <span className="num text-[11.5px] font-semibold w-9 text-right">{pct}%</span>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-[#737373] text-[12px]">
                    {fmtRange(s.start_date, s.end_date)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Modals ────────────────────────────────────────────────────────────

function StartSprintModal({
  open, onClose, teamName, onStarted,
}: {
  open: boolean; onClose: () => void; teamName: string; onStarted: () => void;
}) {
  const [name, setName] = useState("");
  const [endDate, setEndDate] = useState("");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // Default to a 2-week sprint
      const d = new Date();
      d.setDate(d.getDate() + 14);
      setEndDate(d.toISOString().slice(0, 10));
      setName(""); setGoal(""); setError(null);
    }
  }, [open]);

  async function submit() {
    if (!name.trim()) { setError("Name required"); return; }
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/sprints`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), endDate: endDate || null, goal: goal.trim() || null }),
      });
      const d = await r.json();
      if (!d.ok) { setError(d.error || "Could not start."); return; }
      onStarted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-24 px-4 bg-black/40" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md bg-white border border-black/15 rounded-[8px] shadow-[0_2px_4px_rgba(0,0,0,0.06),0_8px_28px_rgba(0,0,0,0.12)] overflow-hidden">
        <div className="px-5 py-4 border-b border-black/10">
          <div className="dash-label">Team {teamName}</div>
          <h2 className="text-[18px] font-bold mt-0.5">Start sprint</h2>
        </div>
        <div className="px-5 py-4 space-y-3">
          {error && <div className="dash-card bg-[#FFB1D8]/30 border border-[#FFB1D8] px-3 py-2 text-[13px]">⚠️ {error}</div>}
          <div>
            <label className="dash-label block mb-1.5">Name *</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Q2 release · Week 18 · …"
              className="dash-input w-full"
            />
          </div>
          <div>
            <label className="dash-label block mb-1.5">End date</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="dash-input w-full"
            />
            <div className="text-[11px] text-[#a3a3a3] mt-1">Defaults to two weeks. Used for days-remaining + burndown.</div>
          </div>
          <div>
            <label className="dash-label block mb-1.5">Goal</label>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={3}
              placeholder="What does &quot;done&quot; look like?"
              className="dash-input w-full resize-none"
            />
          </div>
        </div>
        <div className="px-5 py-3 border-t border-black/10 flex items-center justify-between bg-[#FBFAFE]/40">
          <button onClick={onClose} className="text-[13px] text-[#737373] hover:text-black">Cancel</button>
          <button onClick={submit} disabled={busy || !name.trim()} className="dash-btn dash-btn-primary disabled:opacity-40">
            {busy ? "Starting…" : "Start sprint"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddItemModal({
  open, onClose, teamName, members, onAdded,
}: {
  open: boolean; onClose: () => void; teamName: string; members: Member[]; onAdded: () => void;
}) {
  const [title, setTitle] = useState("");
  const [points, setPoints] = useState("1");
  const [assignee, setAssignee] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) { setTitle(""); setPoints("1"); setAssignee(""); setError(null); }
  }, [open]);

  async function submit() {
    if (!title.trim()) { setError("Title required"); return; }
    setBusy(true); setError(null);
    try {
      const m = members.find(x => x.member_phone === assignee);
      const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/sprints/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          storyPoints: Math.max(0, Math.min(100, Number(points) || 1)),
          assignedTo: assignee || null,
          assignedToName: m?.member_name || null,
        }),
      });
      const d = await r.json();
      if (!d.ok) { setError(d.error || "Could not add."); return; }
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-24 px-4 bg-black/40" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md bg-white border border-black/15 rounded-[8px] shadow-[0_2px_4px_rgba(0,0,0,0.06),0_8px_28px_rgba(0,0,0,0.12)] overflow-hidden">
        <div className="px-5 py-4 border-b border-black/10">
          <div className="dash-label">Team {teamName}</div>
          <h2 className="text-[18px] font-bold mt-0.5">Add sprint item</h2>
        </div>
        <div className="px-5 py-4 space-y-3">
          {error && <div className="dash-card bg-[#FFB1D8]/30 border border-[#FFB1D8] px-3 py-2 text-[13px]">⚠️ {error}</div>}
          <div>
            <label className="dash-label block mb-1.5">Title *</label>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ship the onboarding flow"
              className="dash-input w-full"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="dash-label block mb-1.5">Points</label>
              <input
                type="number"
                min={0}
                max={100}
                value={points}
                onChange={(e) => setPoints(e.target.value)}
                className="dash-input w-full"
              />
            </div>
            <div>
              <label className="dash-label block mb-1.5">Assignee</label>
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="dash-input w-full">
                <option value="">Unassigned</option>
                {members.map(m => (
                  <option key={m.member_phone} value={m.member_phone}>
                    {m.member_name || `+${m.member_phone}`}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
        <div className="px-5 py-3 border-t border-black/10 flex items-center justify-between bg-[#FBFAFE]/40">
          <button onClick={onClose} className="text-[13px] text-[#737373] hover:text-black">Cancel</button>
          <button onClick={submit} disabled={busy || !title.trim()} className="dash-btn dash-btn-primary disabled:opacity-40">
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Bits ──────────────────────────────────────────────────────────────

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="bg-white border border-[#E8E3ED] rounded-md px-3 py-2.5">
      <div className="dash-label text-[10px] mb-1">{label}</div>
      <div className="text-[20px] font-bold num leading-none" style={accent ? { color: accent } : undefined}>{value}</div>
    </div>
  );
}

function nextStatus(s: SprintItem["status"]): SprintItem["status"] {
  if (s === "todo") return "in_progress";
  if (s === "in_progress") return "done";
  if (s === "blocked") return "in_progress";
  return "todo"; // done → todo (re-open)
}

function fmtDate(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function fmtRange(start: string, end: string | null): string {
  if (!end) return fmtDate(start);
  return `${fmtDate(start)} → ${fmtDate(end)}`;
}

function fmtAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}
