"use client";

import { useEffect, useState } from "react";

import { readJsonResponse } from "@/lib/http";

type Member = { member_phone: string; member_name: string | null };

export type TeamTaskEditorValue = {
  id: number;
  assigned_to: string;
  title: string;
  description: string | null;
  due_date: string;
  priority: string;
  status: string;
};

export function TeamTaskModal({
  open,
  onClose,
  teamName,
  members,
  onCreated,
  task = null,
}: {
  open: boolean;
  onClose: () => void;
  teamName: string;
  members: Member[];
  onCreated: (message: string) => void;
  task?: TeamTaskEditorValue | null;
}) {
  const [assignee, setAssignee] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [priority, setPriority] = useState("medium");
  const [status, setStatus] = useState("pending");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && task) {
      setAssignee(task.assigned_to);
      setTitle(task.title);
      setDescription(task.description || "");
      setDueAt(toLocalDateTimeInput(task.due_date));
      setPriority(task.priority || "medium");
      setStatus(task.status || "pending");
      setError(null);
    } else if (!open) {
      setAssignee("");
      setTitle("");
      setDescription("");
      setDueAt("");
      setPriority("medium");
      setStatus("pending");
      setError(null);
    }
  }, [open, task]);

  async function submit() {
    if (!assignee || !title.trim() || !dueAt) {
      setError("Assignee, title, and due date are required.");
      return;
    }
    const due = new Date(dueAt);
    if (!Number.isFinite(due.getTime())) {
      setError("Select a valid due date and time.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(task
        ? `/api/team/${encodeURIComponent(teamName)}/tasks/${task.id}`
        : `/api/team/${encodeURIComponent(teamName)}/tasks`, {
        method: task ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assignee,
          title: title.trim(),
          description: description.trim(),
          due_at: due.toISOString(),
          priority,
          status,
        }),
      });
      const data = await readJsonResponse<{
        ok?: boolean;
        error?: string;
        warning?: string | null;
        assignee_name?: string | null;
      }>(response);
      if (!response.ok || !data?.ok) {
        setError(data?.error || "The task could not be created.");
        return;
      }
      onCreated(task
        ? "Task updated."
        : data.warning || `Task assigned to ${data.assignee_name || "the team member"}.`);
      onClose();
    } catch {
      setError("The task could not be created.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  return (
    <div className="crm-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="assign-team-task-title" onMouseDown={onClose}>
      <div onMouseDown={event => event.stopPropagation()} className="crm-modal max-w-[520px]">
        <div className="border-b border-[#e5e3df] px-5 py-4">
          <div className="crm-label">Team {teamName}</div>
          <h2 id="assign-team-task-title" className="mt-1 text-[14px] font-semibold tracking-[-0.02em] text-[#24211f]">{task ? "Edit task" : "Assign task"}</h2>
        </div>
        <div className="px-5 py-4 space-y-3 max-h-[70vh] overflow-y-auto">
          {error && <div className="border border-[#e9caca] bg-[#fffafa] px-3 py-2 text-[11.5px] text-[#8d2727]">{error}</div>}
          <Field label="Assignee *">
            <select value={assignee} onChange={event => setAssignee(event.target.value)} className="crm-select w-full">
              <option value="">Select a team member</option>
              {members.map(member => (
                <option key={member.member_phone} value={member.member_phone}>
                  {member.member_name || `+${member.member_phone}`}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Task title *">
            <input value={title} onChange={event => setTitle(event.target.value)} maxLength={200} className="crm-input w-full" />
          </Field>
          <Field label="Description">
            <textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={2000} rows={3} className="crm-textarea w-full" />
          </Field>
          <Field label="Due date and time *">
            <input type="datetime-local" value={dueAt} onChange={event => setDueAt(event.target.value)} className="crm-input w-full" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Priority">
              <select value={priority} onChange={event => setPriority(event.target.value)} className="crm-select w-full">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </Field>
            <Field label="Status">
              <select value={status} onChange={event => setStatus(event.target.value)} className="crm-select w-full">
                <option value="pending">Pending</option>
                <option value="in_progress">In progress</option>
                <option value="completed">Completed</option>
              </select>
            </Field>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[#e5e3df] px-5 py-4">
          <button onClick={onClose} className="crm-button">Cancel</button>
          <button onClick={() => { void submit(); }} disabled={busy} className="crm-button crm-button-primary disabled:opacity-40">
            {busy ? (task ? "Saving..." : "Assigning...") : (task ? "Save changes" : "Assign task")}
          </button>
        </div>
      </div>
    </div>
  );
}

function toLocalDateTimeInput(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="crm-label mb-1.5 block">{label}</label>
      {children}
    </div>
  );
}
