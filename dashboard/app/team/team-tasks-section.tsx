"use client";

import { useEffect, useMemo, useState } from "react";

import { CrmConfirm, CrmLoading, CrmPagination, CrmState } from "@/components/crm-page";
import { readJsonResponse } from "@/lib/http";
import { TeamTaskModal, type TeamTaskEditorValue } from "./team-task-modal";

type Member = { member_phone: string; member_name: string | null };

type TeamTask = TeamTaskEditorValue & {
  user_phone: string;
  assigned_by: string;
  assignee_name: string | null;
  assigned_by_name: string | null;
  created_at: string | null;
  completed_at: string | null;
};

type StatusFilter = "all" | "pending" | "in_progress" | "completed" | "overdue";
type SortKey = "due" | "newest" | "assignee" | "priority";

const PAGE_SIZE = 8;

export function TeamTasksSection({
  teamName,
  members,
  currentUserPhone,
  adminPhone,
  refreshKey,
  onAssignTask,
  onNotice,
}: {
  teamName: string;
  members: Member[];
  currentUserPhone?: string | null;
  adminPhone: string;
  refreshKey: number;
  onAssignTask: () => void;
  onNotice: (message: string) => void;
}) {
  const [tasks, setTasks] = useState<TeamTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [assignee, setAssignee] = useState("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [priority, setPriority] = useState("all");
  const [sort, setSort] = useState<SortKey>("due");
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<TeamTask | null>(null);
  const [editing, setEditing] = useState<TeamTask | null>(null);
  const [deleting, setDeleting] = useState<TeamTask | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  async function refresh() {
    setError(null);
    try {
      const response = await fetch(`/api/team/${encodeURIComponent(teamName)}/tasks`, { cache: "no-store" });
      const data = await readJsonResponse<{ ok?: boolean; tasks?: TeamTask[]; error?: string }>(response);
      if (!response.ok || !data?.ok) throw new Error(data?.error || "Team tasks could not be loaded.");
      setTasks(data.tasks || []);
    } catch (requestError) {
      setTasks([]);
      setError(requestError instanceof Error ? requestError.message : "Team tasks could not be loaded.");
    }
  }

  useEffect(() => {
    setTasks(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamName, refreshKey]);

  useEffect(() => { setPage(1); }, [search, assignee, status, priority, sort]);

  const counts = useMemo(() => {
    const list = tasks || [];
    const open = list.filter(task => task.status !== "completed").length;
    const inProgress = list.filter(task => task.status === "in_progress").length;
    const overdue = list.filter(isOverdue).length;
    return { total: list.length, open, inProgress, overdue };
  }, [tasks]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const priorityRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
    return [...(tasks || [])]
      .filter(task => !query || [task.title, task.description, task.assignee_name, task.assigned_by_name]
        .some(value => String(value || "").toLowerCase().includes(query)))
      .filter(task => assignee === "all" || normalizePhone(task.assigned_to) === normalizePhone(assignee))
      .filter(task => status === "all" || (status === "overdue" ? isOverdue(task) : task.status === status))
      .filter(task => priority === "all" || task.priority === priority)
      .sort((a, b) => {
        if (sort === "newest") return dateValue(b.created_at) - dateValue(a.created_at);
        if (sort === "assignee") return displayAssignee(a).localeCompare(displayAssignee(b));
        if (sort === "priority") return (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9);
        return dateValue(a.due_date) - dateValue(b.due_date);
      });
  }, [tasks, search, assignee, status, priority, sort]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  async function updateStatus(task: TeamTask) {
    const nextStatus = task.status === "completed" ? "pending" : "completed";
    setBusyId(task.id);
    setError(null);
    try {
      const response = await fetch(`/api/team/${encodeURIComponent(teamName)}/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      const data = await readJsonResponse<{ ok?: boolean; error?: string }>(response);
      if (!response.ok || !data?.ok) throw new Error(data?.error || "The task could not be updated.");
      onNotice(nextStatus === "completed" ? "Task marked complete." : "Task reopened.");
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The task could not be updated.");
    } finally {
      setBusyId(null);
    }
  }

  async function deleteTask() {
    if (!deleting) return;
    setBusyId(deleting.id);
    setError(null);
    try {
      const response = await fetch(`/api/team/${encodeURIComponent(teamName)}/tasks/${deleting.id}`, { method: "DELETE" });
      const data = await readJsonResponse<{ ok?: boolean; error?: string }>(response);
      if (!response.ok || !data?.ok) throw new Error(data?.error || "The task could not be deleted.");
      setDeleting(null);
      onNotice("Task deleted.");
      await refresh();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The task could not be deleted.");
    } finally {
      setBusyId(null);
    }
  }

  function canManage(task: TeamTask) {
    const me = normalizePhone(currentUserPhone);
    return me === normalizePhone(adminPhone) || me === normalizePhone(task.user_phone) || me === normalizePhone(task.assigned_by);
  }

  function canChangeStatus(task: TeamTask) {
    return canManage(task) || normalizePhone(currentUserPhone) === normalizePhone(task.assigned_to);
  }

  if (tasks === null) return <CrmLoading rows={7} />;

  return (
    <div className="space-y-5">
      <section className="crm-panel grid overflow-hidden sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "All tasks", value: counts.total, detail: "Team assignments" },
          { label: "Open", value: counts.open, detail: "Still needs action" },
          { label: "In progress", value: counts.inProgress, detail: "Actively moving" },
          { label: "Overdue", value: counts.overdue, detail: counts.overdue ? "Needs attention" : "Nothing overdue" },
        ].map((item, index) => (
          <div key={item.label} className={`px-5 py-4 ${index > 0 ? "border-t border-[#e5e3df] sm:border-l sm:border-t-0" : ""} ${index === 2 ? "sm:border-l-0 xl:border-l" : ""}`}>
            <div className="crm-label">{item.label}</div>
            <div className="mt-1.5 text-[19px] font-medium tracking-[-0.035em] text-[#24211f]">{item.value}</div>
            <div className="mt-0.5 text-[10.5px] text-[#77736f]">{item.detail}</div>
          </div>
        ))}
      </section>

      <section className="crm-panel overflow-hidden">
        <div className="border-b border-[#e5e3df] px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-[13px] font-semibold tracking-[-0.015em] text-[#24211f]">Team assignments</h3>
              <p className="mt-1 text-[10.5px] leading-[1.5] text-[#77736f]">Track every task assigned to a member of this team.</p>
            </div>
            <button className="crm-button crm-button-primary" onClick={onAssignTask}>+ Assign task</button>
          </div>

          <div className="mt-4 grid gap-2 lg:grid-cols-2 xl:grid-cols-[minmax(220px,1.4fr),repeat(4,minmax(130px,0.7fr)),auto]">
            <label className="relative block">
              <span className="sr-only">Search tasks</span>
              <SearchIcon />
              <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search tasks" className="crm-input w-full pl-8" />
            </label>
            <select aria-label="Filter by assignee" value={assignee} onChange={event => setAssignee(event.target.value)} className="crm-select w-full">
              <option value="all">All assignees</option>
              {members.map(member => <option key={member.member_phone} value={member.member_phone}>{member.member_name || `+${member.member_phone}`}</option>)}
            </select>
            <select aria-label="Filter by status" value={status} onChange={event => setStatus(event.target.value as StatusFilter)} className="crm-select w-full">
              <option value="all">All statuses</option><option value="pending">Pending</option><option value="in_progress">In progress</option><option value="completed">Completed</option><option value="overdue">Overdue</option>
            </select>
            <select aria-label="Filter by priority" value={priority} onChange={event => setPriority(event.target.value)} className="crm-select w-full">
              <option value="all">All priorities</option><option value="high">High priority</option><option value="medium">Medium priority</option><option value="low">Low priority</option>
            </select>
            <select aria-label="Sort tasks" value={sort} onChange={event => setSort(event.target.value as SortKey)} className="crm-select w-full">
              <option value="due">Due date</option><option value="newest">Newest</option><option value="assignee">Assignee</option><option value="priority">Priority</option>
            </select>
            <button className="crm-button" onClick={() => { setSearch(""); setAssignee("all"); setStatus("all"); setPriority("all"); setSort("due"); }}>Clear</button>
          </div>
        </div>

        {error ? (
          <CrmState title="Tasks unavailable" description={error} action={<button className="crm-button" onClick={() => { setTasks(null); void refresh(); }}>Retry</button>} />
        ) : filtered.length === 0 ? (
          <CrmState title={tasks.length ? "No tasks match these filters" : "No team tasks yet"} description={tasks.length ? "Clear or adjust the filters to see more assignments." : "Assign the first task so the team has one place to track ownership and progress."} action={<button className="crm-button crm-button-primary" onClick={onAssignTask}>Assign task</button>} />
        ) : (
          <>
            <div className="hidden overflow-x-auto xl:block">
              <table className="w-full min-w-[920px] border-collapse text-left">
                <thead><tr className="border-b border-[#e5e3df] bg-[#fbfaf7] text-[9.5px] font-semibold uppercase tracking-[0.08em] text-[#77736f]"><th className="px-5 py-3">Task</th><th className="px-4 py-3">Assignee</th><th className="px-4 py-3">Priority</th><th className="px-4 py-3">Due</th><th className="px-4 py-3">Status</th><th className="px-5 py-3 text-right">Actions</th></tr></thead>
                <tbody>{visible.map(task => <TaskRow key={task.id} task={task} busy={busyId === task.id} canManage={canManage(task)} canChangeStatus={canChangeStatus(task)} onView={() => setViewing(task)} onEdit={() => setEditing(task)} onStatus={() => void updateStatus(task)} onDelete={() => setDeleting(task)} />)}</tbody>
              </table>
            </div>
            <div className="divide-y divide-[#e5e3df] xl:hidden">
              {visible.map(task => <TaskCard key={task.id} task={task} busy={busyId === task.id} canManage={canManage(task)} canChangeStatus={canChangeStatus(task)} onView={() => setViewing(task)} onEdit={() => setEditing(task)} onStatus={() => void updateStatus(task)} onDelete={() => setDeleting(task)} />)}
            </div>
            <CrmPagination page={Math.min(page, pageCount)} pageCount={pageCount} total={filtered.length} onPage={setPage} />
          </>
        )}
      </section>

      {viewing ? <TaskDetail task={viewing} onClose={() => setViewing(null)} onEdit={canManage(viewing) ? () => { setViewing(null); setEditing(viewing); } : undefined} /> : null}
      {editing ? <TeamTaskModal open task={editing} teamName={teamName} members={members} onClose={() => setEditing(null)} onCreated={message => { setEditing(null); onNotice(message); void refresh(); }} /> : null}
      {deleting ? <CrmConfirm title="Delete task?" description={`${deleting.title} will be permanently removed from the team task list. This cannot be undone.`} confirmLabel="Delete task" busy={busyId === deleting.id} onConfirm={() => void deleteTask()} onClose={() => busyId === null && setDeleting(null)} /> : null}
    </div>
  );
}

type TaskActions = { task: TeamTask; busy: boolean; canManage: boolean; canChangeStatus: boolean; onView: () => void; onEdit: () => void; onStatus: () => void; onDelete: () => void };

function TaskRow({ task, busy, canManage, canChangeStatus, onView, onEdit, onStatus, onDelete }: TaskActions) {
  return <tr className="border-b border-[#efede8] last:border-b-0 hover:bg-[#fcfbf8]">
    <td className="max-w-[320px] px-5 py-3.5"><button className="block max-w-full truncate text-left text-[11.5px] font-medium text-[#24211f] hover:text-ari-ink hover:underline hover:decoration-[#dec51f]" onClick={onView}>{task.title}</button><div className="mt-0.5 max-w-[300px] truncate text-[10px] text-[#8a8681]">{task.description || "No description"}</div></td>
    <td className="px-4 py-3.5"><Assignee task={task} /></td>
    <td className="px-4 py-3.5"><Priority value={task.priority} /></td>
    <td className={`px-4 py-3.5 text-[10.5px] ${isOverdue(task) ? "font-medium text-[#a33a32]" : "text-[#5f5a55]"}`}>{formatDate(task.due_date)}</td>
    <td className="px-4 py-3.5"><Status value={task.status} /></td>
    <td className="px-5 py-3.5"><div className="flex justify-end gap-2 text-[10.5px]"><button onClick={onView} className="text-[#5f5a55] hover:text-ari-ink">View</button>{canManage && <button onClick={onEdit} className="text-[#5f5a55] hover:text-ari-ink">Edit</button>}{canChangeStatus && <button disabled={busy} onClick={onStatus} className="text-[#5f5a55] hover:text-ari-ink disabled:opacity-40">{task.status === "completed" ? "Reopen" : "Complete"}</button>}{canManage && <button onClick={onDelete} className="text-[#9b3d35] hover:text-[#671f19]">Delete</button>}</div></td>
  </tr>;
}

function TaskCard({ task, busy, canManage, canChangeStatus, onView, onEdit, onStatus, onDelete }: TaskActions) {
  return <article className="p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><button onClick={onView} className="text-left text-[12px] font-medium text-[#24211f]">{task.title}</button><div className="mt-1"><Assignee task={task} /></div></div><Status value={task.status} /></div><div className="mt-3 grid grid-cols-2 gap-3 border-y border-[#efede8] py-3"><div><div className="crm-label">Priority</div><div className="mt-1"><Priority value={task.priority} /></div></div><div><div className="crm-label">Due</div><div className={`mt-1 text-[10.5px] ${isOverdue(task) ? "font-medium text-[#a33a32]" : "text-[#5f5a55]"}`}>{formatDate(task.due_date)}</div></div></div><div className="mt-3 flex flex-wrap gap-2"><button onClick={onView} className="crm-button">View</button>{canManage && <button onClick={onEdit} className="crm-button">Edit</button>}{canChangeStatus && <button disabled={busy} onClick={onStatus} className="crm-button">{task.status === "completed" ? "Reopen" : "Complete"}</button>}{canManage && <button onClick={onDelete} className="crm-button crm-button-danger">Delete</button>}</div></article>;
}

function TaskDetail({ task, onClose, onEdit }: { task: TeamTask; onClose: () => void; onEdit?: () => void }) {
  return <div className="crm-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="team-task-detail-title" onMouseDown={onClose}><div className="crm-modal max-w-[560px]" onMouseDown={event => event.stopPropagation()}><div className="border-b border-[#e5e3df] px-5 py-4"><div className="crm-label">Team task</div><h2 id="team-task-detail-title" className="mt-1 text-[15px] font-semibold tracking-[-0.02em] text-[#24211f]">{task.title}</h2></div><div className="grid gap-px bg-[#e5e3df] sm:grid-cols-2"><Detail label="Assignee" value={displayAssignee(task)} /><Detail label="Assigned by" value={task.assigned_by_name || `+${task.assigned_by}`} /><Detail label="Priority" value={capitalize(task.priority)} /><Detail label="Status" value={statusLabel(task.status)} /><Detail label="Due date" value={formatDate(task.due_date)} /><Detail label="Created" value={formatDate(task.created_at)} /></div><div className="border-t border-[#e5e3df] px-5 py-4"><div className="crm-label">Description</div><p className="mt-1.5 whitespace-pre-wrap text-[11.5px] leading-[1.65] text-[#4e4944]">{task.description || "No description added."}</p></div><div className="flex justify-end gap-2 border-t border-[#e5e3df] px-5 py-4"><button className="crm-button" onClick={onClose}>Close</button>{onEdit && <button className="crm-button crm-button-primary" onClick={onEdit}>Edit task</button>}</div></div></div>;
}

function Detail({ label, value }: { label: string; value: string }) { return <div className="bg-white px-5 py-3.5"><div className="crm-label">{label}</div><div className="mt-1 text-[11.5px] text-[#24211f]">{value}</div></div>; }
function Assignee({ task }: { task: TeamTask }) { const name = displayAssignee(task); return <div className="flex items-center gap-2"><span className="grid h-6 w-6 place-items-center rounded-full bg-[#f3edcf] text-[9px] font-semibold text-[#4e4630]">{name.charAt(0).toUpperCase()}</span><span className="max-w-[130px] truncate text-[10.5px] text-[#403b36]">{name}</span></div>; }
function Priority({ value }: { value: string }) { const colors: Record<string, string> = { high: "border-[#e5c2bd] bg-[#fff7f5] text-[#9b3d35]", medium: "border-[#e7d9a8] bg-[#fffbec] text-[#735d12]", low: "border-[#d7d8d2] bg-[#f7f7f3] text-[#66645f]" }; return <span className={`crm-status ${colors[value] || colors.low}`}>{capitalize(value)}</span>; }
function Status({ value }: { value: string }) { const colors: Record<string, string> = { pending: "border-[#ddd9ce] bg-[#f8f6ef] text-[#6f685d]", in_progress: "border-[#c9d9d1] bg-[#f2faf5] text-[#096645]", completed: "border-[#cbdac8] bg-[#f4faf2] text-[#376c35]" }; return <span className={`crm-status ${colors[value] || colors.pending}`}><span className="h-1 w-1 rounded-full bg-current" />{statusLabel(value)}</span>; }
function SearchIcon() { return <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8a8681]"><circle cx="9" cy="9" r="5" stroke="currentColor" strokeWidth="1.5"/><path d="m13 13 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>; }
function displayAssignee(task: TeamTask) { return task.assignee_name || `+${task.assigned_to}`; }
function statusLabel(value: string) { return value === "in_progress" ? "In progress" : capitalize(value); }
function capitalize(value: string) { return value ? value.charAt(0).toUpperCase() + value.slice(1) : "—"; }
function dateValue(value: string | null) { const timestamp = value ? new Date(value).getTime() : Number.MAX_SAFE_INTEGER; return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER; }
function formatDate(value: string | null) { if (!value) return "No due date"; const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "Invalid date"; }
function isOverdue(task: TeamTask) { return task.status !== "completed" && dateValue(task.due_date) < Date.now(); }
function normalizePhone(value?: string | null) { return String(value || "").replace(/\D/g, ""); }
