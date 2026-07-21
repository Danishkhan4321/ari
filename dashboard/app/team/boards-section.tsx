"use client";

// Boards — Kanban view per team. List of boards on top; clicking one
// expands a 4-column Kanban (todo · in_progress · blocked · done).
//
// Drag-and-drop: whole card is draggable; drop on any column body to
// change status. Uses native HTML5 drag-drop (no extra deps). Updates
// the UI optimistically and PATCHes the server in the background; if
// the API call fails we revert by re-fetching the canonical state.
import { useEffect, useState, DragEvent } from "react";
import Link from "next/link";
import { EmptyState } from "@/components/dash-page";

type BoardTask = {
  id: number; board_id: number;
  title: string; description: string | null;
  assigned_to: string | null; assigned_to_name: string | null;
  status: string; priority: string;
  due_date: string | null;
  created_by: string; created_at: string; completed_at: string | null;
};

type BoardWithTasks = {
  id: number; team_admin_phone: string; name: string; description: string | null;
  created_by: string; created_at: string;
  task_count: number;
  tasks: BoardTask[];
};

type Member = { member_phone: string; member_name: string | null };

const STATUSES: { key: string; label: string; color: string }[] = [
  { key: "todo",        label: "To do",       color: "#a3a3a3" },
  { key: "in_progress", label: "In progress", color: "#8A65FF" },
  { key: "blocked",     label: "Blocked",     color: "#ef4444" },
  { key: "done",        label: "Done",        color: "#3FAA6E" },
];

const PRIORITY_STYLES: Record<string, { bg: string; fg: string }> = {
  low:    { bg: "#a3a3a322", fg: "#737373" },
  normal: { bg: "#8A65FF22", fg: "#4C2CAB" },
  high:   { bg: "#ef444422", fg: "#b91c1c" },
};

// Stable color picker keyed off the assignee name so a person is the
// same color across cards.
const AVATAR_COLORS = ["#6E49E8", "#8A65FF", "#FFB1D8", "#A78BFA", "#3FAA6E", "#FBBF24", "#F472B6"];
function colorFor(name: string | null): string {
  if (!name) return "#E8E3ED";
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function formatDueDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(d); due.setHours(0, 0, 0, 0);
  const diffDays = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays === -1) return "Yesterday";
  if (diffDays > 0 && diffDays < 7) return d.toLocaleDateString("en-US", { weekday: "short" });
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short" });
}

export function BoardsSection({
  teamName, isAdmin, members,
}: {
  teamName: string; isAdmin: boolean; members: Member[];
}) {
  const [boards, setBoards] = useState<BoardWithTasks[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openBoardId, setOpenBoardId] = useState<number | null>(null);
  const [newBoardOpen, setNewBoardOpen] = useState(false);
  const [addTaskBoardId, setAddTaskBoardId] = useState<number | null>(null);
  const [addTaskInitialStatus, setAddTaskInitialStatus] = useState<string>("todo");
  // Drag state. dragOverStatus highlights the column currently hovered.
  const [draggingTaskId, setDraggingTaskId] = useState<number | null>(null);
  const [dragOverStatus, setDragOverStatus] = useState<string | null>(null);

  async function refresh() {
    try {
      const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/boards?include=tasks`, { cache: "no-store" });
      const d = await r.json();
      if (d.ok) {
        setBoards(d.boards);
        if (openBoardId === null && d.boards.length > 0) setOpenBoardId(d.boards[0].id);
      } else setError(d.error || "Could not load.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [teamName]);

  if (boards === null) return <div className="dash-card p-10 text-center text-[13px] text-[#a3a3a3]">Loading boards…</div>;

  if (boards.length === 0) {
    return (
      <>
        <EmptyState
          icon="📋"
          title="No boards yet"
          body={
            isAdmin
              ? "Boards are Kanban lists for ongoing work that doesn't fit a sprint — bug backlog, marketing pipeline, content calendar."
              : `Ask the admin to create a board, or text Ari: "create board: backlog for ${teamName}".`
          }
          cta={isAdmin && (
            <button onClick={() => setNewBoardOpen(true)} className="dash-btn dash-btn-primary">
              + New board
            </button>
          )}
        />
        <NewBoardModal
          open={newBoardOpen}
          onClose={() => setNewBoardOpen(false)}
          teamName={teamName}
          onCreated={() => { setNewBoardOpen(false); void refresh(); }}
        />
      </>
    );
  }

  const open = boards.find(b => b.id === openBoardId) ?? boards[0];

  // ─── Drag handlers ─────────────────────────────────────────────────
  function onDragStart(e: DragEvent<HTMLDivElement>, taskId: number) {
    setDraggingTaskId(taskId);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(taskId));
  }
  function onDragEnd() {
    setDraggingTaskId(null);
    setDragOverStatus(null);
  }
  function onColumnDragOver(e: DragEvent<HTMLDivElement>, status: string) {
    // preventDefault is REQUIRED for drop to fire on this target.
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragOverStatus !== status) setDragOverStatus(status);
  }
  function onColumnDragLeave() {
    setDragOverStatus(null);
  }
  async function onColumnDrop(e: DragEvent<HTMLDivElement>, newStatus: string) {
    e.preventDefault();
    const raw = e.dataTransfer.getData("text/plain");
    const taskId = Number(raw) || draggingTaskId;
    setDragOverStatus(null);
    setDraggingTaskId(null);
    if (!taskId) return;

    const task = open.tasks.find(t => t.id === taskId);
    if (!task || task.status === newStatus) return;

    const prevStatus = task.status;
    // Optimistic update — apply locally first so the card moves immediately.
    setBoards(prev => prev?.map(b =>
      b.id === task.board_id
        ? { ...b, tasks: b.tasks.map(t => t.id === taskId ? { ...t, status: newStatus } : t) }
        : b
    ) ?? null);

    try {
      const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/boards/${task.board_id}/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      const d = await r.json();
      if (!d.ok) {
        // Revert: roll back the local change so the UI matches the server.
        setBoards(prev => prev?.map(b =>
          b.id === task.board_id
            ? { ...b, tasks: b.tasks.map(t => t.id === taskId ? { ...t, status: prevStatus } : t) }
            : b
        ) ?? null);
        setError(d.error || "Could not move task.");
      }
    } catch (err) {
      setBoards(prev => prev?.map(b =>
        b.id === task.board_id
          ? { ...b, tasks: b.tasks.map(t => t.id === taskId ? { ...t, status: prevStatus } : t) }
          : b
      ) ?? null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="space-y-5">
      {error && (
        <div className="dash-card bg-[#FFB1D8]/30 border border-[#FFB1D8] px-4 py-3 text-sm">
          ⚠️ {error} <button onClick={() => setError(null)} className="ml-2">×</button>
        </div>
      )}

      {/* Board picker pills */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="inline-flex gap-1 bg-white border border-[#E8E3ED] rounded-lg p-1 flex-wrap">
          {boards.map(b => (
            <button
              key={b.id}
              onClick={() => setOpenBoardId(b.id)}
              className={`dash-tab ${open.id === b.id ? "dash-tab-active" : ""}`}
            >
              {b.name}
              <span className={`ml-1.5 num text-[10px] ${open.id === b.id ? "text-white/65" : "text-[#a3a3a3]"}`}>
                {b.task_count}
              </span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => { setAddTaskInitialStatus("todo"); setAddTaskBoardId(open.id); }} className="dash-btn">+ Task</button>
          {isAdmin && <button onClick={() => setNewBoardOpen(true)} className="dash-btn">+ Board</button>}
        </div>
      </div>

      {open.description && (
        <div className="text-[12.5px] text-[#737373]">{open.description}</div>
      )}

      {/* Kanban grid */}
      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
        {STATUSES.map(s => {
          const tasks = open.tasks.filter(t => t.status === s.key);
          const isDropTarget = dragOverStatus === s.key;
          return (
            <div
              key={s.key}
              onDragOver={(e) => onColumnDragOver(e, s.key)}
              onDragLeave={onColumnDragLeave}
              onDrop={(e) => onColumnDrop(e, s.key)}
              className={`dash-card overflow-hidden flex flex-col transition-all ${
                isDropTarget ? "ring-2 ring-[#0a0a0a] ring-offset-2 ring-offset-[#FBFAFE]" : ""
              }`}
            >
              <div className="px-4 py-3 border-b border-[#E8E3ED] flex items-center justify-between bg-white">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full" style={{ background: s.color }} />
                  <span className="text-[12px] font-bold uppercase tracking-wider text-[#0a0a0a]">{s.label}</span>
                  <span className="text-[11px] text-[#a3a3a3] num ml-1">{tasks.length}</span>
                </div>
              </div>
              <div className={`p-2.5 space-y-2 min-h-[140px] flex-1 transition-colors ${isDropTarget ? "bg-[#FBFAFE]" : ""}`}>
                {tasks.map(t => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    teamName={teamName}
                    isAdmin={isAdmin}
                    onChanged={refresh}
                    setError={setError}
                    isDragging={draggingTaskId === t.id}
                    onDragStart={(e) => onDragStart(e, t.id)}
                    onDragEnd={onDragEnd}
                  />
                ))}
                <button
                  onClick={() => { setAddTaskInitialStatus(s.key); setAddTaskBoardId(open.id); }}
                  className="w-full text-left text-[12px] text-[#a3a3a3] hover:text-[#0a0a0a] hover:bg-white/70 px-2.5 py-2 rounded-md transition-colors flex items-center gap-1.5"
                >
                  <span className="text-[14px] leading-none">+</span> Add task
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="text-[11px] text-[#a3a3a3] text-center">
        Tip: drag a card between columns to change its status.
      </div>

      {/* Inverse cross-link banner — mirrors the one on /tasks. Reminds
          users that personal to-dos live in a separate, simpler page so
          they don't conflate "things I owe my team" with "things I owe
          myself." */}
      <div className="dash-card bg-white border border-[#E8E3ED] px-4 py-3 flex items-start justify-between gap-3 flex-wrap">
        <div className="text-[12.5px] text-[#737373] leading-relaxed flex-1 min-w-[240px]">
          <span className="font-bold text-[#0a0a0a]">Team vs personal:</span> these boards are shared with your whole team and tracked by status.
          For your <span className="font-bold text-[#0a0a0a]">personal to-do list</span> - quick captures via WhatsApp (&quot;add task: ...&quot;) - use My tasks.
        </div>
        <Link
          href="/tasks"
          className="dash-btn whitespace-nowrap inline-flex items-center gap-1.5 text-[12.5px]"
        >
          Open My tasks <span className="text-[14px] leading-none">→</span>
        </Link>
      </div>

      <NewBoardModal
        open={newBoardOpen}
        onClose={() => setNewBoardOpen(false)}
        teamName={teamName}
        onCreated={() => { setNewBoardOpen(false); void refresh(); }}
      />
      <AddTaskModal
        open={addTaskBoardId !== null}
        boardId={addTaskBoardId}
        teamName={teamName}
        members={members}
        initialStatus={addTaskInitialStatus}
        onClose={() => setAddTaskBoardId(null)}
        onAdded={() => { setAddTaskBoardId(null); void refresh(); }}
      />
    </div>
  );
}

function TaskCard({
  task, teamName, isAdmin, onChanged, setError,
  isDragging, onDragStart, onDragEnd,
}: {
  task: BoardTask; teamName: string; isAdmin: boolean;
  onChanged: () => void; setError: (s: string | null) => void;
  isDragging: boolean;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function del(e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm("Delete this task?")) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/boards/${task.board_id}/tasks/${task.id}`, {
        method: "DELETE",
      });
      const d = await r.json();
      if (!d.ok) setError(d.error || "Could not delete.");
      else onChanged();
    } finally { setBusy(false); }
  }

  const due = formatDueDate(task.due_date);
  const prio = PRIORITY_STYLES[task.priority] || PRIORITY_STYLES.normal;
  const showPriority = task.priority && task.priority !== "normal";
  const avatarColor = colorFor(task.assigned_to_name);

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`bg-white border border-[#E8E3ED] rounded-md p-3 hover:border-[#0a0a0a] hover:shadow-[0_2px_8px_rgba(0,0,0,0.04)] transition-all group cursor-grab active:cursor-grabbing select-none ${
        isDragging ? "opacity-30 rotate-1" : ""
      }`}
    >
      {/* Title */}
      <div className="text-[13.5px] font-medium leading-snug break-words text-[#0a0a0a] mb-2">
        {task.title}
      </div>

      {/* Description (truncated) */}
      {task.description && (
        <div className="text-[11.5px] text-[#737373] leading-snug break-words mb-2.5 line-clamp-2">
          {task.description}
        </div>
      )}

      {/* Tags row: priority + due date */}
      {(showPriority || due) && (
        <div className="flex items-center gap-2 flex-wrap mb-2.5">
          {showPriority && (
            <span
              className="px-1.5 py-0.5 rounded text-[9.5px] font-bold uppercase tracking-wider"
              style={{ background: prio.bg, color: prio.fg }}
            >
              {task.priority}
            </span>
          )}
          {due && (
            <span className="text-[10.5px] text-[#737373] inline-flex items-center gap-1">
              <span className="text-[9px]">📅</span> {due}
            </span>
          )}
        </div>
      )}

      {/* Footer row: assignee + delete */}
      <div className="flex items-center justify-between gap-2 pt-2 border-t border-[#f0eee5]">
        <div className="flex items-center gap-1.5 min-w-0">
          {task.assigned_to_name ? (
            <>
              <span
                className="w-5 h-5 rounded-full text-[9.5px] flex items-center justify-center font-bold text-[#0a0a0a] border border-[#0a0a0a]/20 shrink-0"
                style={{ background: avatarColor }}
              >
                {task.assigned_to_name.charAt(0).toUpperCase()}
              </span>
              <span className="truncate text-[11.5px] text-[#0a0a0a]">{task.assigned_to_name}</span>
            </>
          ) : (
            <span className="text-[11px] text-[#a3a3a3]">Unassigned</span>
          )}
        </div>
        {isAdmin && (
          <button
            onClick={del}
            disabled={busy}
            className="opacity-0 group-hover:opacity-100 text-[#a3a3a3] hover:text-[#ef4444] px-1 text-[16px] leading-none transition-opacity"
            aria-label="Delete task"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}

function NewBoardModal({
  open, onClose, teamName, onCreated,
}: {
  open: boolean; onClose: () => void; teamName: string; onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (!open) { setName(""); setDesc(""); setError(null); } }, [open]);

  async function submit() {
    if (!name.trim()) { setError("Name required"); return; }
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/boards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: desc.trim() || null }),
      });
      const d = await r.json();
      if (!d.ok) { setError(d.error || "Could not create."); return; }
      onCreated();
    } finally { setBusy(false); }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-24 px-4 bg-black/40" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md bg-white border border-black/15 rounded-[8px] shadow-[0_8px_28px_rgba(0,0,0,0.12)] overflow-hidden">
        <div className="px-5 py-4 border-b border-black/10">
          <div className="dash-label">Team {teamName}</div>
          <h2 className="text-[18px] font-bold mt-0.5">New board</h2>
        </div>
        <div className="px-5 py-4 space-y-3">
          {error && <div className="dash-card bg-[#FFB1D8]/30 border border-[#FFB1D8] px-3 py-2 text-[13px]">⚠️ {error}</div>}
          <div>
            <label className="dash-label block mb-1.5">Name *</label>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Backlog" className="dash-input w-full" />
          </div>
          <div>
            <label className="dash-label block mb-1.5">Description</label>
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} className="dash-input w-full resize-none" />
          </div>
        </div>
        <div className="px-5 py-3 border-t border-black/10 flex items-center justify-between bg-[#FBFAFE]/40">
          <button onClick={onClose} className="text-[13px] text-[#737373] hover:text-black">Cancel</button>
          <button onClick={submit} disabled={busy || !name.trim()} className="dash-btn dash-btn-primary disabled:opacity-40">
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddTaskModal({
  open, boardId, teamName, members, initialStatus, onClose, onAdded,
}: {
  open: boolean; boardId: number | null; teamName: string;
  members: Member[]; initialStatus: string;
  onClose: () => void; onAdded: () => void;
}) {
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [priority, setPriority] = useState("normal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (!open) { setTitle(""); setAssignee(""); setPriority("normal"); setError(null); } }, [open]);

  async function submit() {
    if (!boardId) return;
    if (!title.trim()) { setError("Title required"); return; }
    setBusy(true); setError(null);
    try {
      const m = members.find(x => x.member_phone === assignee);
      const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/boards/${boardId}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          assignedTo: assignee || null,
          assignedToName: m?.member_name || null,
          priority,
          status: initialStatus,
        }),
      });
      const d = await r.json();
      if (!d.ok) { setError(d.error || "Could not add."); return; }
      onAdded();
    } finally { setBusy(false); }
  }

  if (!open || !boardId) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-24 px-4 bg-black/40" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md bg-white border border-black/15 rounded-[8px] shadow-[0_8px_28px_rgba(0,0,0,0.12)] overflow-hidden">
        <div className="px-5 py-4 border-b border-black/10">
          <h2 className="text-[18px] font-bold">Add task</h2>
          {initialStatus !== "todo" && (
            <div className="text-[11.5px] text-[#737373] mt-0.5">
              In column: <span className="font-bold">{STATUSES.find(s => s.key === initialStatus)?.label || initialStatus}</span>
            </div>
          )}
        </div>
        <div className="px-5 py-4 space-y-3">
          {error && <div className="dash-card bg-[#FFB1D8]/30 border border-[#FFB1D8] px-3 py-2 text-[13px]">⚠️ {error}</div>}
          <div>
            <label className="dash-label block mb-1.5">Title *</label>
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} className="dash-input w-full" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="dash-label block mb-1.5">Assignee</label>
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className="dash-input w-full">
                <option value="">Unassigned</option>
                {members.map(m => <option key={m.member_phone} value={m.member_phone}>{m.member_name || `+${m.member_phone}`}</option>)}
              </select>
            </div>
            <div>
              <label className="dash-label block mb-1.5">Priority</label>
              <select value={priority} onChange={(e) => setPriority(e.target.value)} className="dash-input w-full">
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
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
