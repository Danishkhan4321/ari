"use client";

// My tasks list — personal todo list, captured via WhatsApp ("add task: …").
// Distinct from Team Boards (/team#tab=board) which are shared Kanban with
// status columns. Tabs filter Mine / Assigned to me / Delegated / Done.
// Each row is a circular tick + description + meta + hover-revealed delete.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useEntityEvents } from "@/lib/use-entity-events";
import { PageHead, StatusPill, Tabs, EmptyState } from "@/components/dash-page";

type Task = {
  id: number; title: string | null; description: string; status: string;
  priority: string | null; assigned_to: string | null; assigned_by: string | null;
  due_date: string | null;
};

type FilterKey = "mine" | "to-me" | "by-me" | "done";

export function TasksContent() {
  const [mine, setMine] = useState<Task[] | null>(null);
  const [toMe, setToMe] = useState<Task[]>([]);
  const [byMe, setByMe] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [filter, setFilter] = useState<FilterKey>("mine");

  async function refresh() {
    try {
      const res = await fetch("/api/tasks/list", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { mine: Task[]; assignedToMe: Task[]; assignedByMe: Task[] };
      setMine(data.mine); setToMe(data.assignedToMe); setByMe(data.assignedByMe); setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load.");
    }
  }
  useEffect(() => { void refresh(); }, []);
  // Refetch when the agent mutates tasks while this page is open (C-2).
  useEntityEvents(["tasks"], () => void refresh());

  async function act(id: number, action: "complete" | "reopen" | "delete") {
    setBusy(id);
    try {
      const res = await fetch("/api/tasks/update", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error || "Action failed.");
      } else { await refresh(); }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
    } finally { setBusy(null); }
  }

  const buckets = useMemo(() => {
    const m = mine ?? [];
    return {
      mine: m.filter(t => t.status !== "completed"),
      "to-me": toMe.filter(t => t.status !== "completed"),
      "by-me": byMe,
      done: m.filter(t => t.status === "completed"),
    } as Record<FilterKey, Task[]>;
  }, [mine, toMe, byMe]);

  const counts = {
    mine: buckets.mine.length,
    "to-me": buckets["to-me"].length,
    "by-me": buckets["by-me"].length,
    done: buckets.done.length,
  };
  const visible = buckets[filter];

  if (mine === null) {
    return (
      <>
        <PageHead title="Tasks" subtitle="Loading…" />
        <div className="dash-card p-10 text-center text-[13px] text-[#a3a3a3]">Loading…</div>
      </>
    );
  }

  return (
    <>
      <PageHead
        title="My tasks"
        subtitle={
          <>
            Your personal to-do list. Add a task via WhatsApp:{" "}
            <span className="font-mono text-[12.5px] bg-white border border-[#E8E3ED] rounded px-1.5 py-0.5">
              add task: review PR by Friday
            </span>
          </>
        }
        badge={{ label: `${counts.mine} open · ${counts.done} done`, color: "#D8CCFF" }}
      />

      {/* Cross-link banner: clarifies that team work lives elsewhere so
          users don't end up with the same task tracked in two places.
          Matches the inverse banner on /team#tab=board. */}
      <div className="dash-card bg-white border border-[#E8E3ED] px-4 py-3 mb-5 flex items-start justify-between gap-3 flex-wrap">
        <div className="text-[12.5px] text-[#737373] leading-relaxed flex-1 min-w-[240px]">
          <span className="font-bold text-[#0a0a0a]">Personal vs team:</span> tasks here are just for you, captured via WhatsApp.
          For shared work with your team — bug backlog, content pipeline, launch checklist — use{" "}
          <span className="font-bold text-[#0a0a0a]">Team</span> for assignment and coordination.
        </div>
        <Link
          href="/team"
          className="dash-btn whitespace-nowrap inline-flex items-center gap-1.5 text-[12.5px]"
        >
          Open Team <span className="text-[14px] leading-none">→</span>
        </Link>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <Tabs<FilterKey>
          value={filter}
          onChange={setFilter}
          options={[
            { value: "mine",  label: "Mine",         count: counts.mine },
            { value: "to-me", label: "Assigned",     count: counts["to-me"] },
            { value: "by-me", label: "Delegated",    count: counts["by-me"] },
            { value: "done",  label: "Done",         count: counts.done },
          ]}
        />
      </div>

      {error && (
        <div className="dash-card bg-[#FFB1D8]/30 border border-[#FFB1D8] px-4 py-3 text-sm mb-4">⚠️ {error}</div>
      )}

      {visible.length === 0 ? (
        <EmptyState
          icon="🎯"
          title={filter === "done" ? "Nothing finished yet" : "Nothing here"}
          body={
            filter === "mine"
              ? "No open tasks. Tell Ari: \"add task: <description>\" on WhatsApp."
              : filter === "to-me"
              ? "No tasks assigned to you yet."
              : filter === "by-me"
              ? "No tasks you've delegated yet."
              : "Tasks you mark done land here."
          }
        />
      ) : (
        <section className="dash-card-hero overflow-hidden">
          <ul>
            {visible.map((t, i) => {
              const done = t.status === "completed";
              const showAssignee = filter === "to-me" || filter === "by-me";
              return (
                <li
                  key={t.id}
                  className={`flex items-center gap-4 px-6 py-4 hover:bg-[#FBFAFE] transition-colors group ${
                    i !== visible.length - 1 ? "border-b border-[#E8E3ED]" : ""
                  }`}
                >
                  <button
                    disabled={busy === t.id}
                    onClick={() => act(t.id, done ? "reopen" : "complete")}
                    aria-label={done ? "Reopen" : "Mark done"}
                    className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-all ${
                      done
                        ? "bg-[#3FAA6E] border-[#3FAA6E] text-white"
                        : "border-[#d4d4d4] hover:border-[#0a0a0a]"
                    } disabled:opacity-50`}
                  >
                    {done && (
                      <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                        <path d="M3 6l2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </button>

                  <div className="flex-1 min-w-0">
                    <div className={`text-[13.5px] font-medium break-words ${
                      done ? "line-through text-[#a3a3a3]" : "text-[#0a0a0a]"
                    }`}>
                      {t.title || t.description}
                    </div>
                    {t.title && t.description && (
                      <div className="text-[12px] text-[#737373] mt-1 break-words">{t.description}</div>
                    )}
                    {(showAssignee || (t.priority && t.priority !== "normal")) && (
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        {showAssignee && t.assigned_to && (
                          <span className="text-[11px] text-[#737373]">→ <span className="font-mono">+{t.assigned_to}</span></span>
                        )}
                        {showAssignee && t.assigned_by && (
                          <span className="text-[11px] text-[#737373]">by <span className="font-mono">+{t.assigned_by}</span></span>
                        )}
                        {t.priority && t.priority !== "normal" && (
                          <StatusPill color={priorityColor(t.priority)}>{t.priority}</StatusPill>
                        )}
                        {t.due_date && (
                          <span className="text-[11px] text-[#737373]">Due {new Date(t.due_date).toLocaleString()}</span>
                        )}
                      </div>
                    )}
                  </div>

                  <button
                    aria-label="Delete"
                    disabled={busy === t.id}
                    onClick={() => act(t.id, "delete")}
                    className="opacity-0 group-hover:opacity-100 text-[#a3a3a3] hover:text-[#0a0a0a] flex-shrink-0 px-2 transition-opacity"
                  >×</button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <p className="text-[12px] text-[#a3a3a3] mt-4 text-center">
        Showing {visible.length} task{visible.length === 1 ? "" : "s"}
      </p>
    </>
  );
}

function priorityColor(p: string): string {
  const k = p.toLowerCase();
  if (k.startsWith("high") || k.startsWith("urgent")) return "#ef4444";
  if (k.startsWith("med")) return "#F59E0B";
  return "#a3a3a3";
}
