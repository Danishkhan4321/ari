"use client";

// Drag-drop kanban built on native HTML5 DnD (no library). Six fixed
// columns map to the canonical sales stages. Cards from sales_leads
// without a stage land in "Lead". Drop a card on a column → POST to
// /api/contacts/stage with the new stage. Optimistic move with rollback
// on failure.
//
// A group selector at the top scopes the board to a single contact_group
// — only leads in that group appear. "All leads" (default) shows every
// lead in the user's CRM.
import { useEffect, useMemo, useState } from "react";
import { SkeletonList } from "@/components/skeletons";
import { STAGES, STAGE_LABELS, STAGE_ACCENTS, normalizeStage, type Stage } from "@/lib/crm-shared";

type Lead = {
  id: number;
  name: string;
  company: string | null;
  email: string | null;
  stage: string | null;
  deal_value: number | null;
  groups: string[];
};

type Group = { id: number; name: string; emoji: string | null; member_count: number };

// Kanban columns ARE the canonical stages (single source of truth lives in
// crm-shared). normalizeStage() maps any legacy/fuzzy value onto one of them.
type Col = { key: Stage; label: string; accent: string };
const COLUMNS: Col[] = STAGES.map((k) => ({ key: k, label: STAGE_LABELS[k], accent: STAGE_ACCENTS[k] }));

export function PipelineBoard() {
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState<number | "all">("all");
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load groups once for the selector. Loaded from /api/groups/list which
  // returns every group the user owns.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/groups/list", { cache: "no-store" })
      .then(r => r.json())
      .then((d: { ok: boolean; groups?: Group[] }) => {
        if (!cancelled && d?.ok) setGroups(d.groups || []);
      })
      .catch(() => { /* groups optional */ });
    return () => { cancelled = true; };
  }, []);

  // Reload leads whenever the group filter changes. Sends ?group=ID to
  // the list API which INNER-JOINs against contact_group_members.
  async function refresh() {
    try {
      const url = groupId === "all"
        ? "/api/contacts/list"
        : `/api/contacts/list?group=${groupId}`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { leads: Lead[] };
      setLeads(data.leads || []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load.");
    }
  }
  useEffect(() => { setLeads(null); void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [groupId]);

  const grouped = useMemo(() => {
    const out: Record<string, Lead[]> = {};
    for (const k of STAGES) out[k] = [];
    for (const l of leads ?? []) {
      out[normalizeStage(l.stage)].push(l);
    }
    return out;
  }, [leads]);

  async function moveTo(id: number, stage: string) {
    if (!leads) return;
    const before = leads;
    // Optimistic update
    setLeads(leads.map((l) => l.id === id ? { ...l, stage } : l));
    try {
      const res = await fetch("/api/contacts/stage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, stage }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error || "Could not update stage.");
        setLeads(before); // rollback
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
      setLeads(before);
    }
  }

  const selectedGroup = groupId === "all" ? null : groups.find(g => g.id === groupId) || null;

  // Selector + counts row sit ABOVE the board so the user always sees
  // them even on empty results.
  const selector = (
    <div className="flex items-end justify-between gap-3 flex-wrap mb-5">
      <div className="flex items-center gap-2.5">
        <label className="dash-label">Group</label>
        <select
          value={groupId === "all" ? "all" : String(groupId)}
          onChange={(e) => setGroupId(e.target.value === "all" ? "all" : Number(e.target.value))}
          className="dash-input min-w-[220px]"
        >
          <option value="all">All leads ({leads?.length ?? "…"})</option>
          {groups.map(g => (
            <option key={g.id} value={g.id}>
              {g.emoji || ""} {g.name} ({g.member_count})
            </option>
          ))}
        </select>
        {selectedGroup && (
          <a
            href={`/contacts/groups/${selectedGroup.id}`}
            className="text-[12px] text-[#737373] hover:text-[#0a0a0a] underline-offset-2 hover:underline"
          >
            Open group →
          </a>
        )}
      </div>
      {leads && leads.length > 0 && (
        <div className="text-[12px] text-[#737373]">
          {leads.length} lead{leads.length === 1 ? "" : "s"} · drag a card between columns to update its stage.
        </div>
      )}
    </div>
  );

  if (leads === null) {
    return <>{selector}<SkeletonList count={3} /></>;
  }
  if (leads.length === 0) {
    return (
      <>
        {selector}
        <div className="dash-card p-12 text-center">
          <div className="text-5xl mb-3">📭</div>
          <div className="dash-h2 text-[15px]">
            {selectedGroup ? `No leads in "${selectedGroup.name}"` : "No leads in your pipeline yet"}
          </div>
          <div className="text-[13px] text-[#737373] mt-2">
            {selectedGroup
              ? <>Add leads to this group from <a href={`/contacts/groups/${selectedGroup.id}`} className="underline">{selectedGroup.name}</a>.</>
              : <>Tell Ari on WhatsApp: <span className="font-mono">add lead Acme Corp $50k</span></>
            }
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {selector}
      {error && (
        <div className="dash-card bg-[#FFB1D8]/30 border border-[#FFB1D8] px-4 py-3 text-sm mb-4">⚠️ {error}</div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
        {COLUMNS.map((s) => {
          const items = grouped[s.key] || [];
          const total = items.reduce((sum, l) => sum + (Number(l.deal_value) || 0), 0);
          return (
            <Column
              key={s.key}
              stage={s}
              items={items}
              total={total}
              draggingId={draggingId}
              onDragStart={(id) => setDraggingId(id)}
              onDragEnd={() => setDraggingId(null)}
              onDrop={(id) => { if (id != null) void moveTo(id, s.key); setDraggingId(null); }}
            />
          );
        })}
      </div>
    </>
  );
}

function Column({
  stage, items, total, draggingId, onDragStart, onDragEnd, onDrop,
}: {
  stage: Col; items: Lead[]; total: number;
  draggingId: number | null;
  onDragStart: (id: number) => void;
  onDragEnd: () => void;
  onDrop: (id: number | null) => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setHover(true); }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHover(false);
        const id = Number(e.dataTransfer.getData("text/plain"));
        if (Number.isFinite(id)) onDrop(id);
        else onDrop(null);
      }}
      className={`dash-card flex flex-col min-h-[400px] overflow-hidden transition-colors ${
        hover ? "border-[#0a0a0a] bg-[#FBFAFE]" : ""
      }`}
    >
      <div className="px-4 py-3 border-b border-[#E8E3ED] flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: stage.accent }} />
          <span className="text-[12.5px] font-semibold truncate">{stage.label}</span>
          <span className="text-[11px] text-[#a3a3a3] num">{items.length}</span>
        </div>
        {total > 0 && (
          <span className="text-[11px] font-medium text-[#737373] num">${formatNum(total)}</span>
        )}
      </div>
      <div className="flex-1 p-3 space-y-2 overflow-y-auto bg-[#FBFAFE]/40">
        {items.length === 0 && (
          <div className="text-center text-[11px] text-[#a3a3a3] py-6">drop a card here</div>
        )}
        {items.map((l) => (
          <a
            key={l.id}
            href={`/contacts/${l.id}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", String(l.id));
              e.dataTransfer.effectAllowed = "move";
              onDragStart(l.id);
            }}
            onDragEnd={onDragEnd}
            className={`block bg-white border border-[#E8E3ED] rounded-lg p-3 cursor-grab active:cursor-grabbing hover:border-[#0a0a0a] hover:shadow-[2px_2px_0_#0a0a0a] transition-all ${
              draggingId === l.id ? "opacity-40" : ""
            }`}
          >
            <div className="text-[13px] font-medium leading-snug truncate">{l.name}</div>
            {l.company && <div className="text-[11.5px] text-[#737373] truncate mt-0.5">{l.company}</div>}
            {l.deal_value != null && Number(l.deal_value) > 0 && (
              <div className="text-[11.5px] num font-medium mt-2">${formatNum(Number(l.deal_value))}</div>
            )}
          </a>
        ))}
      </div>
    </div>
  );
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return Math.round(n).toLocaleString();
}
