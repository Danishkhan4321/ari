"use client";

// AI Plan modal — admin types a one-paragraph goal + timeline. Ari
// generates a structured project plan (12-30 tasks with assignees,
// story points, week-offsets), shows a preview, and on accept creates
// a new Sprint with all items in one click.
//
// Mounted from sprints-section.tsx alongside the regular Start Sprint
// flow — they're alternatives, not extensions of each other.
import { useEffect, useState } from "react";

type Member = { member_phone: string; member_name: string | null };

type PlanItem = {
  title: string;
  description: string | null;
  story_points: number;
  assigned_to_name: string;
  assigned_to_phone: string | null;
  week_offset: number;
};

type Plan = {
  plan_name: string;
  summary: string;
  weeks: number;
  items: PlanItem[];
};

export function AiPlanModal({
  open, onClose, teamName, members, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  teamName: string;
  members: Member[];
  onCreated: () => void;
}) {
  const [step, setStep] = useState<"prompt" | "preview" | "creating">("prompt");
  const [goal, setGoal] = useState("");
  const [weeks, setWeeks] = useState("6");
  const [generating, setGenerating] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setStep("prompt"); setGoal(""); setWeeks("6"); setPlan(null); setError(null); setGenerating(false);
    }
  }, [open]);

  async function generate() {
    if (!goal.trim()) { setError("Tell Ari what you're trying to ship."); return; }
    setGenerating(true); setError(null);
    try {
      const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/sprints/plan-with-ai`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: goal.trim(), weeks: Number(weeks) || 6 }),
      });
      const d = await r.json();
      if (!d.ok) { setError(d.error || "Could not generate."); return; }
      setPlan(d as Plan);
      setStep("preview");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }

  async function accept() {
    if (!plan) return;
    setStep("creating"); setError(null);
    try {
      // 1. Create the sprint with end_date = today + weeks*7 days
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + plan.weeks * 7);
      const sprintRes = await fetch(`/api/team/${encodeURIComponent(teamName)}/sprints`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: plan.plan_name,
          endDate: endDate.toISOString().slice(0, 10),
          goal: plan.summary,
        }),
      });
      const sprintData = await sprintRes.json();
      if (!sprintData.ok) {
        setError(sprintData.error || "Could not create sprint.");
        setStep("preview");
        return;
      }

      // 2. Insert items one-by-one (the existing items API takes one at a time).
      // Small N (≤30); good enough — could be batched later.
      let added = 0;
      for (const it of plan.items) {
        try {
          const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/sprints/items`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: it.title,
              storyPoints: it.story_points,
              assignedTo: it.assigned_to_phone || null,
              assignedToName: it.assigned_to_name || null,
            }),
          });
          if (r.ok) added++;
        } catch { /* per-item non-fatal */ }
      }
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("preview");
    }
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-12 pb-12 px-4 bg-black/40 overflow-y-auto" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-2xl bg-white border border-black/15 rounded-[8px] shadow-[0_8px_28px_rgba(0,0,0,0.12)] overflow-hidden">
        <div className="px-5 py-4 border-b border-black/10 flex items-start justify-between">
          <div>
            <div className="dash-label">Team {teamName}</div>
            <h2 className="text-[18px] font-bold mt-0.5 flex items-center gap-2">
              <span>✨</span> Plan with AI
            </h2>
          </div>
          <button onClick={onClose} className="text-2xl text-[#737373] hover:text-black px-2">×</button>
        </div>

        {step === "prompt" && (
          <>
            <div className="px-5 py-4 space-y-3">
              {error && <div className="dash-card bg-[#FFB1D8]/30 border border-[#FFB1D8] px-3 py-2 text-[13px]">⚠️ {error}</div>}
              <div>
                <label className="dash-label block mb-1.5">What are you trying to ship? *</label>
                <textarea
                  autoFocus
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  rows={5}
                  placeholder={`Examples:
• Launch our new SaaS product for SMB India in 8 weeks. Team of 5 engineers + 1 marketer.
• Q3 marketing push for our agency: 4 case studies, 2 webinars, redesigned landing page.
• Onboard our first 10 enterprise customers in 6 weeks.`}
                  className="dash-input w-full resize-none leading-relaxed"
                />
                <div className="text-[11px] text-[#a3a3a3] mt-1">
                  Be specific about what &ldquo;done&rdquo; looks like, who&apos;s on the team, and any constraints.
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="dash-label block mb-1.5">Timeline (weeks) *</label>
                  <input
                    type="number"
                    min={1}
                    max={26}
                    value={weeks}
                    onChange={(e) => setWeeks(e.target.value)}
                    className="dash-input w-full"
                  />
                </div>
                <div>
                  <label className="dash-label block mb-1.5">Team size</label>
                  <div className="dash-input w-full text-[#737373]">
                    {members.length} {members.length === 1 ? "member" : "members"}
                  </div>
                </div>
              </div>
            </div>
            <div className="px-5 py-3 border-t border-black/10 flex items-center justify-between bg-[#FBFAFE]/40">
              <button onClick={onClose} className="text-[13px] text-[#737373] hover:text-black">Cancel</button>
              <button onClick={generate} disabled={generating || !goal.trim()} className="dash-btn dash-btn-primary disabled:opacity-40">
                {generating ? "Generating…" : "✨ Generate plan"}
              </button>
            </div>
          </>
        )}

        {step === "preview" && plan && (
          <>
            <div className="px-5 py-4">
              {error && <div className="dash-card bg-[#FFB1D8]/30 border border-[#FFB1D8] px-3 py-2 text-[13px] mb-3">⚠️ {error}</div>}
              <div className="dash-card-hero p-4 mb-4">
                <div className="dash-label mb-1">Generated plan · {plan.weeks} weeks · {plan.items.length} tasks</div>
                <h3 className="text-[18px] font-bold leading-tight">{plan.plan_name}</h3>
                {plan.summary && <p className="text-[13px] text-[#525252] mt-1.5 leading-relaxed">{plan.summary}</p>}
              </div>

              {/* Group items by week_offset */}
              <div className="space-y-4 max-h-[50vh] overflow-y-auto">
                {Array.from({ length: plan.weeks }, (_, w) => w).map(w => {
                  const itemsThisWeek = plan.items.filter(it => it.week_offset === w);
                  if (itemsThisWeek.length === 0) return null;
                  const totalPts = itemsThisWeek.reduce((a, it) => a + it.story_points, 0);
                  return (
                    <div key={w}>
                      <div className="dash-label mb-2 flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#8A65FF]" />
                        Week {w + 1}
                        <span className="text-[#a3a3a3] font-normal">· {itemsThisWeek.length} {itemsThisWeek.length === 1 ? "task" : "tasks"} · {totalPts} pts</span>
                      </div>
                      <ul className="space-y-1.5">
                        {itemsThisWeek.map((it, i) => (
                          <li key={i} className="flex items-start gap-3 px-3 py-2 bg-white border border-[#E8E3ED] rounded-md text-[13px]">
                            <span className="w-3.5 h-3.5 rounded-full border border-[#a3a3a3] mt-0.5 flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="leading-snug break-words">{it.title}</div>
                              {it.description && (
                                <div className="text-[11.5px] text-[#737373] mt-0.5 leading-relaxed">{it.description}</div>
                              )}
                              <div className="text-[11px] text-[#a3a3a3] mt-1 flex items-center gap-2 flex-wrap">
                                {it.assigned_to_name && (
                                  <span className="inline-flex items-center gap-1">
                                    <span className="w-3.5 h-3.5 rounded-full bg-[#6E49E8] border border-[#0a0a0a] text-[8.5px] flex items-center justify-center font-bold text-[#0a0a0a]">
                                      {it.assigned_to_name.charAt(0).toUpperCase()}
                                    </span>
                                    {it.assigned_to_name}
                                  </span>
                                )}
                                <span className="font-mono">{it.story_points} {it.story_points === 1 ? "pt" : "pts"}</span>
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="px-5 py-3 border-t border-black/10 flex items-center justify-between bg-[#FBFAFE]/40 flex-wrap gap-2">
              <button onClick={() => { setStep("prompt"); setError(null); }} className="text-[13px] text-[#737373] hover:text-black">
                ← Edit prompt
              </button>
              <div className="flex items-center gap-2">
                <button onClick={generate} disabled={generating} className="dash-btn disabled:opacity-40">
                  {generating ? "Regenerating…" : "Regenerate"}
                </button>
                <button onClick={accept} className="dash-btn dash-btn-primary">
                  Use this plan ({plan.items.length} tasks)
                </button>
              </div>
            </div>
          </>
        )}

        {step === "creating" && (
          <div className="px-5 py-12 text-center">
            <div className="text-[14px] text-[#737373]">Creating sprint and adding {plan?.items.length} tasks…</div>
          </div>
        )}
      </div>
    </div>
  );
}
