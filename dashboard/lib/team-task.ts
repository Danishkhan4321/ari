export type TeamTaskInput = {
  assignee: string;
  title: string;
  description: string | null;
  dueAt: string;
  priority: "low" | "medium" | "high";
  status: "pending" | "in_progress" | "completed";
};

export type TeamTaskParseResult =
  | { ok: true; value: TeamTaskInput }
  | { ok: false; error: string };

export type TeamTaskUpdateInput = Partial<TeamTaskInput>;
export type TeamTaskUpdateParseResult =
  | { ok: true; value: TeamTaskUpdateInput }
  | { ok: false; error: string };

export function parseTeamTaskInput(input: unknown): TeamTaskParseResult {
  if (!input || typeof input !== "object") return { ok: false, error: "Task details are required." };
  const body = input as Record<string, unknown>;
  const assignee = String(body.assignee || "").replace(/\D/g, "");
  const title = String(body.title || "").trim().replace(/\s+/g, " ");
  const descriptionText = String(body.description || "").trim();
  const priority = String(body.priority || "medium");
  const status = String(body.status || "pending");
  const due = new Date(String(body.due_at || ""));

  if (!/^\d{8,15}$/.test(assignee)) return { ok: false, error: "Select a valid assignee." };
  if (!title || title.length > 200) return { ok: false, error: "Enter a task title up to 200 characters." };
  if (descriptionText.length > 2000) return { ok: false, error: "Description must be 2,000 characters or less." };
  if (!Number.isFinite(due.getTime())) return { ok: false, error: "Select a valid due date and time." };
  if (!["low", "medium", "high"].includes(priority)) return { ok: false, error: "Select a valid priority." };
  if (!["pending", "in_progress", "completed"].includes(status)) return { ok: false, error: "Select a valid status." };

  return {
    ok: true,
    value: {
      assignee,
      title,
      description: descriptionText || null,
      dueAt: due.toISOString(),
      priority: priority as TeamTaskInput["priority"],
      status: status as TeamTaskInput["status"],
    },
  };
}

export function parseTeamTaskUpdateInput(input: unknown): TeamTaskUpdateParseResult {
  if (!input || typeof input !== "object") return { ok: false, error: "Task changes are required." };
  const body = input as Record<string, unknown>;
  const value: TeamTaskUpdateInput = {};

  if (Object.prototype.hasOwnProperty.call(body, "assignee")) {
    const assignee = String(body.assignee || "").replace(/\D/g, "");
    if (!/^\d{8,15}$/.test(assignee)) return { ok: false, error: "Select a valid assignee." };
    value.assignee = assignee;
  }
  if (Object.prototype.hasOwnProperty.call(body, "title")) {
    const title = String(body.title || "").trim().replace(/\s+/g, " ");
    if (!title || title.length > 200) return { ok: false, error: "Enter a task title up to 200 characters." };
    value.title = title;
  }
  if (Object.prototype.hasOwnProperty.call(body, "description")) {
    const description = String(body.description || "").trim();
    if (description.length > 2000) return { ok: false, error: "Description must be 2,000 characters or less." };
    value.description = description || null;
  }
  if (Object.prototype.hasOwnProperty.call(body, "due_at")) {
    const due = new Date(String(body.due_at || ""));
    if (!Number.isFinite(due.getTime())) return { ok: false, error: "Select a valid due date and time." };
    value.dueAt = due.toISOString();
  }
  if (Object.prototype.hasOwnProperty.call(body, "priority")) {
    const priority = String(body.priority || "");
    if (!["low", "medium", "high"].includes(priority)) return { ok: false, error: "Select a valid priority." };
    value.priority = priority as TeamTaskInput["priority"];
  }
  if (Object.prototype.hasOwnProperty.call(body, "status")) {
    const status = String(body.status || "");
    if (!["pending", "in_progress", "completed"].includes(status)) return { ok: false, error: "Select a valid status." };
    value.status = status as TeamTaskInput["status"];
  }

  if (Object.keys(value).length === 0) return { ok: false, error: "No valid task changes were provided." };
  return { ok: true, value };
}
