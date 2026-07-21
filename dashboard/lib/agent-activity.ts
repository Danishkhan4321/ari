export type AgentEvent = {
  id: number;
  run_id: string;
  event_type: string;
  step: number | null;
  tool_name: string | null;
  summary: string | null;
  created_at: string;
};

export type AgentActivityState = "running" | "success" | "waiting" | "error";

export type AgentActivity = {
  eventId: number;
  runId: string;
  key: string;
  label: string;
  state: AgentActivityState;
  createdAt: string;
};

const MAX_VISIBLE_ACTIVITIES = 8;

const TERMINAL_AGENT_EVENTS = new Set([
  "run.completed",
  "run.failed",
  "run.partial",
  "run.cancelled",
  "run.waiting_for_approval",
  "run.waiting_for_user",
  "run.finished",
]);

export function isTerminalAgentEvent(eventType: string): boolean {
  return TERMINAL_AGENT_EVENTS.has(eventType);
}

function readableName(value: string | null): string {
  if (!value) return "Action";
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

type ToolMoment = "running" | "success" | "error";

function toolCopy(toolName: string | null, moment: ToolMoment): string {
  const name = toolName?.toLowerCase() ?? "";
  const copy: Record<ToolMoment, string> = name.match(/task|to.?do|priority/)
    ? { running: "Putting the work in order", success: "The work is in order", error: "The task trail hit a snag" }
    : name.match(/reminder|deadline/)
      ? { running: "Checking the time-sensitive details", success: "The reminder is in motion", error: "The reminder could not be set" }
      : name.match(/crm|sales|lead|deal|pipeline|contact|follow.?up/)
        ? { running: "Following the deal trail", success: "The pipeline context is ready", error: "The deal trail went quiet" }
        : name.match(/meeting|call|minutes|transcript|recording/)
          ? { running: "Gathering the meeting trail", success: "The meeting context is ready", error: "The meeting trail could not be reached" }
          : name.match(/inbox|email|mail|message|reply/)
            ? { running: "Reading the conversation trail", success: "The conversation details are ready", error: "The conversation trail could not be reached" }
            : name.match(/team|member|standup|handoff|leave|poll/)
              ? { running: "Mapping ownership and handoffs", success: "The team context is ready", error: "The team context could not be reached" }
              : name.match(/calendar|schedule|briefing|today/)
                ? { running: "Bringing the day into focus", success: "The day is in focus", error: "The schedule could not be reached" }
                : {
                    running: `Opening ${readableName(toolName).toLowerCase()}`,
                    success: `${readableName(toolName)} is ready`,
                    error: `${readableName(toolName)} hit a snag`,
                  };
  return copy[moment];
}

function usefulSummary(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  if (/^(understanding|preparing|processing|running|executing|working on)\b/i.test(summary)) return undefined;
  return summary;
}

function describe(event: AgentEvent): Pick<AgentActivity, "key" | "label" | "state"> {
  const summary = event.summary?.trim();
  const useful = usefulSummary(summary);
  const toolKey = `${event.run_id}:tool:${event.step ?? 0}:${event.tool_name ?? "pending"}`;

  switch (event.event_type) {
    case "tool.started":
      return { key: toolKey, label: useful || toolCopy(event.tool_name, "running"), state: "running" };
    case "tool.succeeded":
      return { key: toolKey, label: useful || toolCopy(event.tool_name, "success"), state: "success" };
    case "tool.failed":
      return { key: toolKey, label: useful || toolCopy(event.tool_name, "error"), state: "error" };
    case "run.completed":
      return { key: `${event.run_id}:run`, label: useful || "Wrapped up and checked", state: "success" };
    case "run.failed":
      return { key: `${event.run_id}:run`, label: useful || "The path stopped short", state: "error" };
    case "run.partial":
      return { key: `${event.run_id}:run`, label: useful || "Stopped with an unverified result", state: "error" };
    case "run.cancelled":
      return { key: `${event.run_id}:run`, label: useful || "Stopped", state: "error" };
    case "run.waiting_for_approval":
      return { key: `${event.run_id}:run`, label: useful || "Waiting for your approval", state: "waiting" };
    case "run.waiting_for_user":
      return { key: `${event.run_id}:run`, label: useful || "Waiting for you", state: "waiting" };
    case "tool.requested":
      return { key: `${event.run_id}:planning:${event.step ?? 0}`, label: useful || "Choosing the next workspace move", state: "running" };
    // Model-authored one-liners (Codex-style preambles) and LLM narrator
    // lines. One shared key per run so newer lines replace older ones instead
    // of stacking.
    case "status.preamble":
    case "status.narration":
      return { key: `${event.run_id}:status`, label: summary || "Working on it", state: "running" };
    case "run.finished":
      return { key: `${event.run_id}:run`, label: useful || "Done", state: "success" };
    default:
      return { key: `${event.run_id}:run`, label: useful || "Reading between the lines", state: "running" };
  }
}

export function reduceAgentActivities(
  current: AgentActivity[],
  event: AgentEvent,
): AgentActivity[] {
  if (current.some((activity) => activity.eventId === event.id)) return current;

  const base = event.event_type === "run.started" && current.some((item) => item.runId !== event.run_id)
    ? []
    : current;
  const withoutPlanning = event.event_type.startsWith("tool.") && event.event_type !== "tool.requested"
    ? base.filter((item) => item.key !== `${event.run_id}:planning:${event.step ?? 0}`)
    : base;
  const display = describe(event);
  const activity: AgentActivity = {
    eventId: event.id,
    runId: event.run_id,
    createdAt: event.created_at,
    ...display,
  };

  const existingIndex = withoutPlanning.findIndex((item) => item.key === activity.key);
  const next = [...withoutPlanning];
  if (existingIndex >= 0) next[existingIndex] = activity;
  else next.push(activity);
  return next.slice(-MAX_VISIBLE_ACTIVITIES);
}
