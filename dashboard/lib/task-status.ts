export type TaskStatusTheme = "crm" | "meetings" | "team" | "communication" | "personal" | "general";

const STATUS_LINES: Record<TaskStatusTheme, readonly string[]> = {
  crm: [
    "Following the deal trail",
    "Reading the pipeline signals",
    "Lining up the next move",
  ],
  meetings: [
    "Gathering the room's context",
    "Tracing decisions and follow-ups",
    "Setting the next steps in order",
  ],
  team: [
    "Mapping ownership and handoffs",
    "Reading the team rhythm",
    "Bringing the moving pieces together",
  ],
  communication: [
    "Reading the conversation trail",
    "Finding the signal in the inbox",
    "Shaping the clearest reply",
  ],
  personal: [
    "Untangling today's priorities",
    "Checking deadlines and loose ends",
    "Putting the next steps in order",
  ],
  general: [
    "Reading between the lines",
    "Tracing the best path",
    "Choosing the right workspace moves",
  ],
};

export function taskStatusTheme(prompt: string): TaskStatusTheme {
  const value = prompt.toLowerCase();

  if (/\b(meetings?|calls?|agendas?|minutes|transcripts?|recordings?)\b/.test(value)) return "meetings";
  if (/\b(crm|sales|leads?|deals?|pipelines?|contacts?|prospects?|follow[- ]?ups?)\b/.test(value)) return "crm";
  if (/\b(team|members?|standups?|handoffs?|owners?|ownership|leave|polls?)\b/.test(value)) return "team";
  if (/\b(inbox|emails?|mail|messages?|replies|reply|drafts?|send|scheduled? email)\b/.test(value)) return "communication";
  if (/\b(tasks?|reminders?|priorities|priority|deadlines?|today|tomorrow|plan my day|to[- ]?dos?)\b/.test(value)) return "personal";
  return "general";
}

export function taskStatusLines(prompt: string): readonly string[] {
  return STATUS_LINES[taskStatusTheme(prompt)];
}
