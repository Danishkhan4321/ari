// dashboard/lib/crm-shared.ts
// CLIENT-SAFE CRM constants, types, and pure helpers. This file must NOT
// import anything server-only (no ./db, no pg). It's imported by the
// client component (crm-client.tsx) as well as the server page, so dragging
// a Postgres dependency in here would pull `pg` into the browser bundle
// (webpack: "Can't resolve 'fs'/'dns'/'net'/'tls'"). Keep it pure.

export const STAGES = [
  "new",
  "contacted",
  "replied",
  "meeting",
  "proposal",
  "negotiation",
  "closed_won",
  "closed_lost",
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  new: "New",
  contacted: "Contacted",
  replied: "Replied",
  meeting: "Meeting",
  proposal: "Proposal",
  negotiation: "Negotiation",
  closed_won: "Won",
  closed_lost: "Lost",
};

export const STAGE_COLORS: Record<Stage, string> = {
  new: "bg-card-lemon",
  contacted: "bg-card-lime",
  replied: "bg-card-lime",
  meeting: "bg-card-purple",
  proposal: "bg-card-purple",
  negotiation: "bg-card-orange",
  closed_won: "bg-card-lemon",
  closed_lost: "bg-card",
};

// Hex accents for the kanban column dots (inline style, not Tailwind classes).
export const STAGE_ACCENTS: Record<Stage, string> = {
  new: "#8A65FF",
  contacted: "#D8CCFF",
  replied: "#8A65FF",
  meeting: "#B7A8FF",
  proposal: "#FFB1D8",
  negotiation: "#FBBF77",
  closed_won: "#D8CCFF",
  closed_lost: "#A3A3A3",
};

// Legacy / fuzzy stage values → canonical. Older rows (and the previous
// 6-stage board) used "lead"/"qualified"/"won"/"lost"; the bot and the DB
// migration canonicalize to STAGES, but this keeps any un-migrated row
// displaying in the right place. The 6_canonicalize_lead_stages migration
// backfills the stored values; this is the read-side safety net.
const STAGE_ALIASES: Record<string, Stage> = {
  lead: "new",
  qualified: "contacted",
  discovery: "contacted",
  won: "closed_won",
  lost: "closed_lost",
};

/** Map any free-form stage string onto a canonical Stage. Pure / client-safe. */
export function normalizeStage(raw: string | null | undefined): Stage {
  const s = String(raw ?? "").toLowerCase().trim();
  if ((STAGES as readonly string[]).includes(s)) return s as Stage;
  if (s in STAGE_ALIASES) return STAGE_ALIASES[s];
  if (!s) return "new";
  if (s.includes("propos")) return "proposal";
  if (s.includes("negotia")) return "negotiation";
  if (s.includes("meet")) return "meeting";
  if (s.includes("repl")) return "replied";
  if (s.includes("contact") || s.includes("qualif") || s.includes("discov")) return "contacted";
  if (s.includes("won")) return "closed_won";
  if (s.includes("lost")) return "closed_lost";
  return "new";
}

export interface Lead {
  id: number;
  name: string;
  email: string | null;
  company: string | null;
  stage: Stage;
  notes: string | null;
  source: string | null;
  priority: Priority | null;
  deal_value: string | null; // pg NUMERIC comes back as string
  last_contacted_at: string | null;
  next_followup_at: string | null;
  created_at: string;
  updated_at: string;
}

// Lead priority — a cheap, manual stand-in for full lead scoring.
export const PRIORITIES = ["high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABELS: Record<Priority, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

// Pill background classes (reuse the existing brand palette tokens).
export const PRIORITY_COLORS: Record<Priority, string> = {
  high: "bg-card-orange/40",
  medium: "bg-card-lemon",
  low: "bg-card",
};

/** Narrow an arbitrary string to a valid Priority (or null). */
export function normalizePriority(v: unknown): Priority | null {
  const s = String(v ?? "").toLowerCase().trim();
  return (PRIORITIES as readonly string[]).includes(s) ? (s as Priority) : null;
}

export interface Contact {
  id: number;
  name: string;
  phone: string;
  notes: string | null;
  category: string | null;
  created_at: string;
}

export interface PipelineStats {
  totalLeads: number;
  openValue: number;
  wonValue: number;
  byStage: Record<Stage, { count: number; value: number }>;
}

/** Pure aggregation — safe on client or server. */
export function computeStats(leads: Lead[]): PipelineStats {
  const byStage = Object.fromEntries(
    STAGES.map((s) => [s, { count: 0, value: 0 }])
  ) as Record<Stage, { count: number; value: number }>;

  let openValue = 0;
  let wonValue = 0;
  for (const l of leads) {
    // Normalize so legacy/un-migrated rows (e.g. "won") bucket correctly into
    // wonValue rather than falling through to "new" → openValue. Keeps the KPI
    // strip correct independent of when the 6_canonicalize migration runs.
    const stage = normalizeStage(l.stage);
    const val = l.deal_value ? Number(l.deal_value) || 0 : 0;
    byStage[stage].count += 1;
    byStage[stage].value += val;
    if (stage === "closed_won") wonValue += val;
    else if (stage !== "closed_lost") openValue += val;
  }
  return { totalLeads: leads.length, openValue, wonValue, byStage };
}
