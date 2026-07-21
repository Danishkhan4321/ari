"use client";

// Team — operational hub. Top: team selector pills (or "+ New team" if
// you have none). Below: a single team's "Today" view: standup status
// per member, active polls with vote counts, leave today, open
// incidents, then a member roster. Modals for creating teams + adding
// members.
import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { StatusPill } from "@/components/dash-page";
import { CrmConfirm, CrmLoading, CrmPagination, CrmState, CrmToast } from "@/components/crm-page";
import { BulkInviteModal } from "./bulk-invite-modal";
import { SetupChecklist } from "./setup-checklist";
import { PendingWidget } from "./pending-widget";
import { HashtagsWidget } from "./hashtags-widget";
import { trackSync } from "@/lib/analytics";
import { TeamTaskModal } from "./team-task-modal";

// Lazy-load every section component. Users on the default Today tab
// no longer download JS for the other 10 surfaces. Each chunk loads
// on first click and is cached for the rest of the session.
//
// Loading state mirrors the section-shell skeleton so the swap is
// visually quiet rather than a flash-of-empty-content.
const SECTION_LOADER = () => (
  <div className="dash-card p-10 text-center text-[13px] text-[#a3a3a3]">Loading…</div>
);
const TeamChatSection     = dynamic(() => import("../messages/messages-content").then(m => ({ default: m.MessagesContent })), { loading: SECTION_LOADER });
const BroadcastsSection   = dynamic(() => import("./broadcasts-section").then(m => ({ default: m.BroadcastsSection })),     { loading: SECTION_LOADER });
const CalendarSection     = dynamic(() => import("./calendar-section").then(m => ({ default: m.CalendarSection })),         { loading: SECTION_LOADER });
const SettingsSection     = dynamic(() => import("./settings-section").then(m => ({ default: m.SettingsSection })),         { loading: SECTION_LOADER });
const TeamTasksSection    = dynamic(() => import("./team-tasks-section").then(m => ({ default: m.TeamTasksSection })),      { loading: SECTION_LOADER });

type TeamTab = "today" | "members" | "tasks" | "chat" | "broadcasts" | "calendar" | "settings";

const TEAM_TABS: { value: TeamTab; label: string }[] = [
  { value: "today",      label: "Overview" },
  { value: "members",    label: "Members" },
  { value: "tasks",      label: "Tasks" },
  { value: "chat",       label: "Team Chat" },
  { value: "calendar",   label: "Calendar" },
  { value: "broadcasts", label: "Broadcasts" },
  { value: "settings",   label: "Settings" },
];

type TeamRef = { name: string; member_count: number; is_admin: boolean; admin_phone: string; your_role: string | null };

type Member = {
  id: number;
  member_phone: string;
  member_name: string | null;
  role: string | null;
  last_standup_at: string | null;
  streak: number | null;
};

type StandupAnswer = { question: string; answer: string };
type StandupPerMember = {
  member_phone: string;
  member_name: string | null;
  submitted: boolean;
  answers: StandupAnswer[];
  submitted_at: string | null;
};
type StandupConfig = {
  id: number;
  name: string;
  questions: string[];
  schedule_days: string | null;
  is_active: boolean;
};

type Poll = {
  id: number;
  question: string;
  options: string[];
  created_at: string;
  deadline: string | null;
  is_anonymous: boolean;
  multi_select: boolean;
  status: string;
  creator_phone: string;
  counts: number[];
  your_vote: number | null;
  total_votes: number;
};

type Leave = {
  id: number;
  employee_phone: string;
  employee_name: string | null;
  leave_type: string;
  start_date: string;
  end_date: string;
  status: string;
  half_day: boolean;
  half_day_period: string | null;
  reason: string | null;
};

type Incident = {
  id: number; title: string; description: string | null; severity: string;
  status: string; reported_by_name: string | null; assigned_to_name: string | null; created_at: string;
};

type TodayPayload = {
  team: { name: string; admin_phone: string; is_admin: boolean; member_count: number };
  members: Member[];
  standup: {
    config: StandupConfig | null;
    perMember: StandupPerMember[];
    submitted_count: number;
    waiting_count: number;
  };
  polls: Poll[];
  leaveToday: Leave[];
  incidents: Incident[];
};

export function TeamContent({ userPhone }: { userPhone?: string | null } = {}) {
  const [teams, setTeams] = useState<TeamRef[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<TeamTab>("today");
  const [today, setToday] = useState<TodayPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [taskRefreshKey, setTaskRefreshKey] = useState(0);
  const [teamNotice, setTeamNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Persist tab selection in the URL hash so refreshes / back-button
  // land you on the same view. Hash (vs query) keeps it client-only —
  // server rendering doesn't need to know about the tab.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const m = window.location.hash.match(/^#tab=([a-z]+)/);
    if (m && (TEAM_TABS as { value: string }[]).some(t => t.value === m[1])) {
      setTab(m[1] as TeamTab);
    }
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const next = `#tab=${tab}`;
    if (window.location.hash !== next) {
      // replaceState to avoid polluting browser history with each tab click
      window.history.replaceState(null, "", window.location.pathname + next);
    }
    // Fire analytics — fire-and-forget. Lets us see in PostHog which
    // tabs people actually use, so we can deprecate dead ones later.
    trackSync("team_tab_opened", { tab, team: selected || "" });
  }, [tab, selected]);

  // Bootstrap teams list. Pick first team as default.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/team/list", { cache: "no-store" })
      .then(r => r.json())
      .then((d: { ok: boolean; teams?: TeamRef[]; error?: string }) => {
        if (cancelled) return;
        if (!d.ok) { setError(d.error || "Could not load teams."); return; }
        setTeams(d.teams || []);
        if (d.teams && d.teams.length > 0 && !selected) {
          // Prefer a team where you're admin first
          const owned = d.teams.find(t => t.is_admin);
          setSelected(owned?.name || d.teams[0].name);
        }
      })
      .catch(e => !cancelled && setError(String(e)));
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload today payload whenever selection changes.
  async function refreshToday(team = selected) {
    if (!team) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/team/${encodeURIComponent(team)}/today`, { cache: "no-store" });
      const d = await r.json();
      if (d.ok) setToday(d as TodayPayload);
      else setError(d.error || "Could not load.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { setToday(null); void refreshToday(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [selected]);

  // ─── Empty: no teams at all ────────────────────────────────────────
  if (teams !== null && teams.length === 0) {
    return (
      <>
        <div className="mt-6">
          <CrmState
            title="No teams yet"
            description="Create a workspace for your team, then add people, assign work, and manage daily operations from one clear view."
            action={<button onClick={() => setCreateOpen(true)} className="crm-button crm-button-primary">Create team</button>}
          />
        </div>
        <CreateTeamModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={(name) => { void fetchTeamsAndSelect(name, setTeams, setSelected, setError); setCreateOpen(false); }}
        />
      </>
    );
  }

  // ─── Loading bootstrap ─────────────────────────────────────────────
  if (teams === null) {
    return <div className="mt-6"><CrmLoading rows={5} /></div>;
  }

  return (
    <>
      {error && (
        <div className="mt-5 flex items-center justify-between gap-3 border border-[#e9caca] bg-[#fffafa] px-4 py-3 text-[11.5px] text-[#8d2727]">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-[#8d2727] hover:text-[#511]" aria-label="Dismiss error">×</button>
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <label htmlFor="team-selector" className="crm-label mb-1.5 block">Current team</label>
          <div className="flex items-center gap-2">
            <select id="team-selector" value={selected || ""} onChange={(event) => setSelected(event.target.value)} className="crm-select min-w-[220px]">
              {teams.map(team => (
                <option key={`${team.admin_phone}-${team.name}`} value={team.name}>
                  {displayTeamName(team.name)} · {team.member_count} {team.member_count === 1 ? "member" : "members"}
                </option>
              ))}
            </select>
            {teams.find(team => team.name === selected)?.is_admin ? (
              <span className="crm-status border-[#c9ded2] bg-[#f2faf5] text-[#096645]">Admin</span>
            ) : (
              <span className="crm-status border-[#deddd8] bg-[#f6f5f1] text-[#77736f]">Member</span>
            )}
          </div>
        </div>
        <button onClick={() => setCreateOpen(true)} className="crm-button">
          <PlusIcon /> New team
        </button>
      </div>

      {!today ? (
        <div className="mt-6"><CrmLoading rows={6} /></div>
      ) : (
        <>
          {/* Team header */}
          <TeamHeader
            today={today}
            onAssignTask={() => setTaskOpen(true)}
            onAddMember={() => setAddMemberOpen(true)}
            onBulkInvite={() => setBulkOpen(true)}
          />

          {/* Section tabs (today / sprints / …) */}
          <div className="mb-6 mt-6 overflow-x-auto border-b border-[#deddd8] [scrollbar-width:none]">
            <nav className="flex min-w-max gap-6" aria-label="Team sections">
              {TEAM_TABS.map(t => (
                <button
                  key={t.value}
                  onClick={() => setTab(t.value)}
                  aria-current={tab === t.value ? "page" : undefined}
                  className={`relative h-9 whitespace-nowrap px-0 text-[12px] font-normal transition hover:text-ari-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-focus ${tab === t.value ? "font-medium text-ari-ink after:absolute after:inset-x-0 after:bottom-[-1px] after:h-[2px] after:rounded-full after:bg-ari-accent" : "text-[#77736f]"}`}
                >
                  {t.label}
                </button>
              ))}
            </nav>
          </div>

          {tab === "today" && (
            <>
              <TeamStats today={today} />

              {/* Setup checklist — only renders for admins, only when not yet complete + not dismissed */}
              <div className="mt-4">
                <SetupChecklist
                  teamName={today.team.name}
                  isAdmin={today.team.is_admin}
                  members={today.members.map(m => ({ member_phone: m.member_phone, member_name: m.member_name }))}
                  hasStandup={!!today.standup.config}
                  onTabChange={(t) => setTab(t)}
                  onOpenBulkInvite={() => setBulkOpen(true)}
                />
              </div>

              {/* Pending widget — silent if there's nothing waiting on the user */}
              <div className="mt-4">
                <PendingWidget teamName={today.team.name} />
              </div>

              {/* Hashtag goals — silent if no one's tagged anything this week */}
              <div className="mt-4">
                <HashtagsWidget teamName={today.team.name} />
              </div>

              {/* Today blocks */}
              <div className="mt-5 grid gap-5 lg:grid-cols-[1.55fr,1fr]">
                <div className="min-w-0 space-y-5">
                  <StandupBlock today={today} />
                  <PollsBlock today={today} onChange={refreshToday} />
                </div>
                <div className="min-w-0 space-y-5">
                  <LeaveBlock today={today} canDecide={today.team.is_admin} onChange={refreshToday} setError={setError} />
                  <IncidentsBlock today={today} />
                </div>
              </div>

            </>
          )}

          {tab === "members" && (
            <MembersBlock
              today={today}
              onChange={refreshToday}
              setError={setError}
              onAddMember={() => setAddMemberOpen(true)}
              onBulkInvite={() => setBulkOpen(true)}
            />
          )}

          {tab === "tasks" && (
            <div className="mt-4">
              <TeamTasksSection
                teamName={today.team.name}
                members={today.members.map(member => ({ member_phone: member.member_phone, member_name: member.member_name }))}
                currentUserPhone={userPhone}
                adminPhone={today.team.admin_phone}
                refreshKey={taskRefreshKey}
                onAssignTask={() => setTaskOpen(true)}
                onNotice={message => setTeamNotice(message)}
              />
            </div>
          )}

          {tab === "chat" && userPhone && (
            <div className="mt-4">
              <TeamChatSection currentUserPhone={userPhone} teamName={today.team.name} />
            </div>
          )}

          {tab === "broadcasts" && (
            <div className="mt-4">
              <BroadcastsSection
                teamName={today.team.name}
                isAdmin={today.team.is_admin}
              />
            </div>
          )}

          {tab === "calendar" && (
            <div className="mt-4">
              <CalendarSection teamName={today.team.name} currentUserPhone={userPhone} />
            </div>
          )}

          {tab === "settings" && (
            <div className="mt-4">
              <SettingsSection
                teamName={today.team.name}
                isAdmin={today.team.is_admin}
                members={today.members.map(m => ({ member_phone: m.member_phone, member_name: m.member_name }))}
              />
            </div>
          )}
        </>
      )}

      {teamNotice ? <CrmToast message={teamNotice} onClose={() => setTeamNotice(null)} /> : null}

      <CreateTeamModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(name) => { void fetchTeamsAndSelect(name, setTeams, setSelected, setError); setCreateOpen(false); }}
      />

      {today && (
        <AddMemberModal
          open={addMemberOpen}
          onClose={() => setAddMemberOpen(false)}
          teamName={today.team.name}
          onAdded={() => { setAddMemberOpen(false); void refreshToday(); }}
        />
      )}

      {today && (
        <TeamTaskModal
          open={taskOpen}
          onClose={() => setTaskOpen(false)}
          teamName={today.team.name}
          members={today.members.map(member => ({ member_phone: member.member_phone, member_name: member.member_name }))}
          onCreated={message => { setTeamNotice(message); setTaskRefreshKey(key => key + 1); }}
        />
      )}

      {today && (
        <BulkInviteModal
          open={bulkOpen}
          onClose={() => setBulkOpen(false)}
          teamName={today.team.name}
          onAdded={(r) => {
            setBulkOpen(false);
            void refreshToday();
            if (r.added > 0 || r.skipped > 0) {
              setTeamNotice(`Added ${r.added} · skipped ${r.skipped}${r.welcomed > 0 ? ` · welcomed ${r.welcomed}` : ""}`);
            }
          }}
        />
      )}
    </>
  );
}

// ─── Team header card ──────────────────────────────────────────────────

function TeamHeader({
  today,
  onAssignTask,
  onAddMember,
  onBulkInvite,
}: {
  today: TodayPayload;
  onAssignTask: () => void;
  onAddMember: () => void;
  onBulkInvite: () => void;
}) {
  return (
    <section className="crm-panel mt-5 flex flex-wrap items-center justify-between gap-5 px-5 py-5">
      <div className="flex min-w-0 items-center gap-3.5">
        <div className="grid h-10 w-10 flex-none place-items-center rounded-full border border-[#dfddd7] bg-[#faf8ef] text-[12px] font-semibold text-[#403a35]">
          {teamInitials(today.team.name)}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-[16px] font-semibold tracking-[-0.025em] text-[#24211f]">{displayTeamName(today.team.name)}</h2>
            <span className="crm-status border-[#c9ded2] bg-[#f2faf5] text-[#096645]">
              <span className="h-1 w-1 rounded-full bg-[#249469]" /> Active
            </span>
          </div>
          <p className="mt-1 text-[11px] text-[#77736f]">
            {today.team.member_count} {today.team.member_count === 1 ? "member" : "members"} · {today.team.is_admin ? "You manage this workspace" : "Shared team workspace"}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={onAssignTask} className="crm-button crm-button-primary"><TaskIcon /> Assign task</button>
        {today.team.is_admin && (
          <>
            <button onClick={onBulkInvite} className="crm-button"><ImportPeopleIcon /> Bulk invite</button>
            <button onClick={onAddMember} className="crm-button"><PlusIcon /> Add member</button>
          </>
        )}
      </div>
    </section>
  );
}

function TeamStats({ today }: { today: TodayPayload }) {
  const submitted = today.standup.submitted_count;
  const pendingLeave = today.leaveToday.filter(item => item.status === "pending").length;
  const activePolls = today.polls.length;
  const openIncidents = today.incidents.length;
  const items = [
    { label: "Members", value: today.team.member_count, detail: "Active roster" },
    { label: "Standups today", value: `${submitted}/${today.team.member_count}`, detail: today.standup.waiting_count ? `${today.standup.waiting_count} waiting` : "All submitted" },
    { label: "Pending approvals", value: pendingLeave, detail: pendingLeave ? "Needs review" : "Nothing pending" },
    { label: "Open work", value: activePolls + openIncidents, detail: `${activePolls} polls · ${openIncidents} incidents` },
  ];
  return (
    <section className="crm-panel grid overflow-hidden sm:grid-cols-2 xl:grid-cols-4">
      {items.map((item, index) => (
        <div key={item.label} className={`px-5 py-4 ${index > 0 ? "border-t border-[#e5e3df] sm:border-l sm:border-t-0" : ""} ${index === 2 ? "sm:border-l-0 xl:border-l" : ""}`}>
          <div className="crm-label">{item.label}</div>
          <div className="mt-1.5 text-[19px] font-medium tracking-[-0.035em] text-[#24211f]">{item.value}</div>
          <div className="mt-0.5 text-[10.5px] text-[#77736f]">{item.detail}</div>
        </div>
      ))}
    </section>
  );
}

// ─── Standup block ─────────────────────────────────────────────────────

function StandupBlock({ today }: { today: TodayPayload }) {
  const cfg = today.standup.config;
  const totalMembers = today.team.member_count;
  if (!cfg) {
    return (
      <section className="dash-card overflow-hidden">
        <BlockHeader accent="#8A65FF" title="Standup today" subtitle="Not configured" />
        <div className="px-5 py-6 text-center text-[13px] text-[#737373]">
          No standup configured for this team. Tell Ari:{" "}
          <span className="font-mono">create standup for {today.team.name}: what did you do, what will you do, blockers?</span>
        </div>
      </section>
    );
  }

  const submittedRatio = totalMembers > 0
    ? `${today.standup.submitted_count}/${totalMembers}`
    : `${today.standup.submitted_count}`;

  return (
    <section className="dash-card overflow-hidden">
      <BlockHeader
        accent="#8A65FF"
        title="Standup today"
        subtitle={`${submittedRatio} submitted · ${cfg.name}`}
      />
      <ul>
        {today.standup.perMember.map((m, i, arr) => (
          <li
            key={m.member_phone}
            className={`px-5 py-4 ${i !== arr.length - 1 ? "border-b border-[#E8E3ED]" : ""}`}
          >
            <div className="flex items-start gap-3">
              <Avatar name={m.member_name || formatPhone(m.member_phone)} done={m.submitted} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[13.5px] font-medium">{m.member_name || formatPhone(m.member_phone)}</span>
                  {m.submitted ? (
                    <StatusPill color="#3FAA6E">Submitted</StatusPill>
                  ) : (
                    <StatusPill color="#a3a3a3">Waiting</StatusPill>
                  )}
                  {m.submitted_at && (
                    <span className="text-[11px] text-[#a3a3a3]">{fmtTime(m.submitted_at)}</span>
                  )}
                </div>
                {m.submitted && m.answers.length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {m.answers.map((a, k) => (
                      <div key={k}>
                        <div className="text-[11px] text-[#737373]">{a.question}</div>
                        <div className="text-[13px] text-[#404040] whitespace-pre-wrap break-words leading-relaxed">{a.answer}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </li>
        ))}
        {today.standup.perMember.length === 0 && (
          <li className="px-5 py-6 text-center text-[13px] text-[#737373]">
            No team members yet. Add some to get standups going.
          </li>
        )}
      </ul>
      {/* Footer hint shown when nobody has submitted yet — answers
          "how does this section help me?" by explicitly telling members
          how to submit. They submit on WhatsApp; this dashboard view
          fills in as soon as Ari receives their message. */}
      {today.standup.submitted_count === 0 && today.standup.perMember.length > 0 && (
        <div className="px-5 py-3 bg-[#FBFAFE]/60 border-t border-[#E8E3ED] text-[11.5px] text-[#737373] leading-relaxed">
          Members submit by texting Ari on WhatsApp:{" "}
          <span className="font-mono text-[#0a0a0a]">standup yesterday: X · today: Y · blockers: none</span>
          <span className="block mt-1">A voice note works too — Ari transcribes and parses it. Answers appear here as soon as she receives them.</span>
        </div>
      )}
    </section>
  );
}

// ─── Polls block ───────────────────────────────────────────────────────

function PollsBlock({ today, onChange }: { today: TodayPayload; onChange: () => void }) {
  const [busyId, setBusyId] = useState<number | null>(null);

  async function vote(pollId: number, optionIndex: number) {
    setBusyId(pollId);
    try {
      const r = await fetch("/api/team/poll/vote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ poll_id: pollId, option_index: optionIndex }),
      });
      const d = await r.json();
      if (d.ok) onChange();
    } finally {
      setBusyId(null);
    }
  }

  if (today.polls.length === 0) {
    return (
      <section className="dash-card overflow-hidden">
        <BlockHeader accent="#D8CCFF" title="Active polls" subtitle="None" />
        <div className="px-5 py-6 text-center text-[13px] text-[#737373]">
          No active polls. Tell Ari:{" "}
          <span className="font-mono">poll {today.team.name}: lunch at 12 or 1?</span>
        </div>
      </section>
    );
  }
  return (
    <section className="dash-card overflow-hidden">
      <BlockHeader accent="#D8CCFF" title="Active polls" subtitle={`${today.polls.length} live`} />
      <div className="divide-y divide-[#E8E3ED]">
        {today.polls.map(p => (
          <div key={p.id} className="px-5 py-4">
            <div className="text-[13.5px] font-semibold mb-3">{p.question}</div>
            <div className="space-y-2">
              {p.options.map((opt, idx) => {
                const count = p.counts[idx] || 0;
                const pct = p.total_votes > 0 ? Math.round((count / p.total_votes) * 100) : 0;
                const isYourVote = p.your_vote === idx;
                return (
                  <button
                    key={idx}
                    onClick={() => vote(p.id, idx)}
                    disabled={busyId === p.id}
                    className={`w-full text-left relative overflow-hidden rounded-md border transition-all ${
                      isYourVote
                        ? "border-[#0a0a0a] bg-[#FBFAFE]"
                        : "border-[#E8E3ED] hover:border-[#0a0a0a] bg-white"
                    } disabled:opacity-50`}
                  >
                    {/* Fill bar */}
                    <span
                      className="absolute inset-y-0 left-0 transition-all"
                      style={{
                        width: `${pct}%`,
                        background: isYourVote ? "rgba(123,211,247,0.25)" : "rgba(232,230,220,0.6)",
                      }}
                    />
                    <span className="relative flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
                      <span className="flex items-center gap-2 min-w-0">
                        <span className={`w-3.5 h-3.5 rounded-full border ${
                          isYourVote ? "border-[#0a0a0a] bg-[#0a0a0a]" : "border-[#a3a3a3]"
                        } flex-shrink-0`}>
                          {isYourVote && <span className="block w-1.5 h-1.5 m-[3px] rounded-full bg-white" />}
                        </span>
                        <span className="truncate">{opt}</span>
                      </span>
                      <span className="text-[11px] num text-[#737373] flex-shrink-0">
                        {count}{p.total_votes > 0 && ` · ${pct}%`}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="text-[11px] text-[#a3a3a3] mt-2.5 flex items-center gap-2 flex-wrap">
              <span>{p.total_votes} {p.total_votes === 1 ? "vote" : "votes"}</span>
              {p.is_anonymous && <span>· anonymous</span>}
              <span>· {fmtAgo(p.created_at)}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Leave today block ─────────────────────────────────────────────────

function LeaveBlock({
  today, canDecide, onChange, setError,
}: {
  today: TodayPayload; canDecide: boolean; onChange: () => void; setError: (s: string | null) => void;
}) {
  const [busyId, setBusyId] = useState<number | null>(null);

  async function decide(id: number, decision: "approved" | "rejected") {
    setBusyId(id);
    try {
      const r = await fetch("/api/team/leave/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, decision }),
      });
      const d = await r.json();
      if (!d.ok) setError(d.error || "Could not update.");
      else onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  const pending = today.leaveToday.filter(l => l.status === "pending");
  const onLeaveNow = today.leaveToday.filter(l => l.status === "approved");

  return (
    <section className="dash-card overflow-hidden">
      <BlockHeader accent="#D8CCFF" title="Leave & approvals" subtitle={pending.length > 0 ? `${pending.length} pending` : "Nothing pending"} />
      {today.leaveToday.length === 0 ? (
        <div className="px-5 py-6 text-center text-[13px] text-[#737373]">No leave requests.</div>
      ) : (
        <div className="divide-y divide-[#E8E3ED]">
          {pending.map(l => (
            <div key={l.id} className="px-5 py-3">
              <div className="text-[13.5px] font-medium">
                {l.employee_name || `+${l.employee_phone}`} · {l.leave_type}
              </div>
              <div className="text-[11.5px] text-[#737373] mt-0.5">
                {fmtRange(l.start_date, l.end_date)}{l.half_day ? ` (half ${l.half_day_period})` : ""}
                {l.reason ? <> — {l.reason}</> : null}
              </div>
              {canDecide && (
                <div className="flex gap-1.5 mt-2">
                  <button
                    disabled={busyId === l.id}
                    onClick={() => decide(l.id, "approved")}
                    className="dash-btn !py-1 !px-2.5 !text-[11px] disabled:opacity-50"
                  >
                    Approve
                  </button>
                  <button
                    disabled={busyId === l.id}
                    onClick={() => decide(l.id, "rejected")}
                    className="dash-btn !py-1 !px-2.5 !text-[11px] disabled:opacity-50"
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          ))}
          {onLeaveNow.map(l => (
            <div key={l.id} className="px-5 py-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[13.5px] font-medium">{l.employee_name || `+${l.employee_phone}`}</div>
                <div className="text-[11.5px] text-[#737373]">
                  Out · {l.leave_type} · {fmtRange(l.start_date, l.end_date)}
                </div>
              </div>
              <StatusPill color="#D8CCFF">On leave</StatusPill>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Incidents block ───────────────────────────────────────────────────

function IncidentsBlock({ today }: { today: TodayPayload }) {
  if (today.incidents.length === 0) {
    return (
      <section className="dash-card overflow-hidden">
        <BlockHeader accent="#a3a3a3" title="Open incidents" subtitle="None" />
        <div className="px-5 py-6 text-center text-[13px] text-[#737373]">
          No open incidents. Anyone can flag one via WhatsApp.
        </div>
      </section>
    );
  }
  return (
    <section className="dash-card overflow-hidden">
      <BlockHeader accent="#ef4444" title="Open incidents" subtitle={`${today.incidents.length} unresolved`} />
      <ul>
        {today.incidents.map((it, i, arr) => (
          <li
            key={it.id}
            className={`px-5 py-3 ${i !== arr.length - 1 ? "border-b border-[#E8E3ED]" : ""}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium break-words">{it.title}</div>
                <div className="text-[11.5px] text-[#737373] mt-0.5">
                  reported by {it.reported_by_name || "—"}
                  {it.assigned_to_name && <> · assigned to {it.assigned_to_name}</>}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1 flex-shrink-0">
                <StatusPill color={severityColor(it.severity)}>{it.severity}</StatusPill>
                <StatusPill color="#8A65FF">{it.status}</StatusPill>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ─── Members roster ────────────────────────────────────────────────────

function MembersBlock({ today, onChange, setError, onAddMember, onBulkInvite }: {
  today: TodayPayload;
  onChange: () => void;
  setError: (value: string | null) => void;
  onAddMember: () => void;
  onBulkInvite: () => void;
}) {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("all");
  const [sort, setSort] = useState("name");
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<Member | null>(null);
  const [editing, setEditing] = useState<Member | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return [...today.members]
      .filter(member => !normalized || `${member.member_name || ""} ${member.member_phone} ${member.role || "member"}`.toLowerCase().includes(normalized))
      .filter(member => role === "all" || (member.role || "member") === role)
      .sort((a, b) => sort === "activity"
        ? new Date(b.last_standup_at || 0).getTime() - new Date(a.last_standup_at || 0).getTime()
        : (a.member_name || a.member_phone).localeCompare(b.member_name || b.member_phone));
  }, [today.members, query, role, sort]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 8));
  const visibleMembers = filtered.slice((page - 1) * 8, page * 8);
  useEffect(() => { setPage(1); }, [query, role, sort]);
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);

  async function removeMember() {
    if (!removing) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/team/${encodeURIComponent(today.team.name)}/members?phone=${encodeURIComponent(removing.member_phone)}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Could not remove this member.");
      setRemoving(null);
      onChange();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Could not remove this member.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="crm-panel overflow-hidden">
      <div className="crm-panel-header flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="crm-section-title">Members</h2>
          <p className="mt-1 text-[10.5px] text-[#77736f]">Manage access, roles, and participation for {displayTeamName(today.team.name)}.</p>
        </div>
        {today.team.is_admin ? (
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={onBulkInvite} className="crm-button"><ImportPeopleIcon /> Bulk invite</button>
            <button onClick={onAddMember} className="crm-button crm-button-primary"><PlusIcon /> Add member</button>
          </div>
        ) : null}
      </div>

      <div className="grid gap-2 border-b border-[#e5e3df] p-4 md:grid-cols-[minmax(220px,1fr),150px,150px]">
        <div className="relative">
          <SearchIcon />
          <input value={query} onChange={event => setQuery(event.target.value)} className="crm-input w-full pl-9" placeholder="Search members or phone" aria-label="Search members" />
        </div>
        <select value={role} onChange={event => setRole(event.target.value)} className="crm-select" aria-label="Filter by role">
          <option value="all">All roles</option>
          <option value="admin">Admin</option>
          <option value="manager">Manager</option>
          <option value="lead">Lead</option>
          <option value="member">Member</option>
        </select>
        <select value={sort} onChange={event => setSort(event.target.value)} className="crm-select" aria-label="Sort members">
          <option value="name">Name A–Z</option>
          <option value="activity">Recent activity</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <CrmState title="No matching members" description="Try a different search or role filter." />
      ) : (
        <div className="crm-table-wrap border-0">
          <table className="crm-table">
            <thead><tr><th>Member</th><th>Role</th><th>Standup activity</th><th>Streak</th><th className="text-right">Actions</th></tr></thead>
            <tbody>
              {visibleMembers.map(member => {
                const isOwner = member.member_phone === today.team.admin_phone;
                return (
                  <tr key={member.id}>
                    <td>
                      <div className="flex items-center gap-3">
                        <Avatar name={member.member_name || formatPhone(member.member_phone)} done={Boolean(member.last_standup_at)} />
                        <div className="min-w-0">
                          <div className="truncate font-medium text-[#24211f]">{member.member_name || formatPhone(member.member_phone)}</div>
                          <div className="mt-0.5 font-mono text-[10px] text-[#918d88]">{formatPhone(member.member_phone)}</div>
                        </div>
                      </div>
                    </td>
                    <td><RoleBadge role={member.role || "member"} /></td>
                    <td>{member.last_standup_at ? `Last active ${fmtAgo(member.last_standup_at)}` : "No standup yet"}</td>
                    <td>{member.streak && member.streak > 0 ? `${member.streak} days` : "—"}</td>
                    <td>
                      <div className="flex justify-end gap-1.5">
                        <button className="crm-icon-button" onClick={() => setViewing(member)} aria-label={`View ${member.member_name || member.member_phone}`} title="View member"><EyeIcon /></button>
                        {today.team.is_admin ? <button className="crm-icon-button" onClick={() => setEditing(member)} aria-label={`Edit ${member.member_name || member.member_phone}`} title="Edit member"><EditIcon /></button> : null}
                        {today.team.is_admin && !isOwner ? <button className="crm-icon-button text-[#a32424]" onClick={() => setRemoving(member)} aria-label={`Remove ${member.member_name || member.member_phone}`} title="Remove member"><TrashIcon /></button> : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {filtered.length > 0 ? <CrmPagination page={page} pageCount={pageCount} total={filtered.length} onPage={setPage} /> : null}

      {viewing ? <MemberDetailModal teamName={today.team.name} member={viewing} onClose={() => setViewing(null)} /> : null}
      {editing ? <EditMemberModal teamName={today.team.name} member={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChange(); }} setError={setError} /> : null}
      {removing ? <CrmConfirm title="Remove member?" description={`${removing.member_name || `+${removing.member_phone}`} will lose access to ${displayTeamName(today.team.name)}. Their historical activity remains available.`} confirmLabel="Remove member" busy={busy} onConfirm={() => void removeMember()} onClose={() => !busy && setRemoving(null)} /> : null}
    </section>
  );
}

// ─── Modals ────────────────────────────────────────────────────────────

function CreateTeamModal({
  open, onClose, onCreated,
}: { open: boolean; onClose: () => void; onCreated: (name: string) => void }) {
  const [name, setName] = useState("");
  const [members, setMembers] = useState<{ name: string; phone: string }[]>([]);
  const [memberName, setMemberName] = useState("");
  const [memberPhone, setMemberPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) { setName(""); setMembers([]); setMemberName(""); setMemberPhone(""); setError(null); }
  }, [open]);

  function addRow() {
    const n = memberName.trim();
    const p = memberPhone.replace(/\D/g, "");
    if (!n || !p) return;
    setMembers(arr => [...arr, { name: n, phone: p }]);
    setMemberName(""); setMemberPhone("");
  }

  async function submit() {
    if (!name.trim()) { setError("Name required"); return; }
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/team/list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), members }),
      });
      const d = await r.json();
      if (!d.ok) { setError(d.error || "Could not create."); return; }
      onCreated(d.team.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  return (
    <div className="crm-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="create-team-title" onMouseDown={onClose}>
      <div onMouseDown={(e) => e.stopPropagation()} className="crm-modal max-w-[520px]">
        <div className="flex items-center justify-between border-b border-[#e5e3df] px-5 py-4">
          <div>
            <div className="crm-label">New workspace</div>
            <h2 id="create-team-title" className="mt-1 text-[14px] font-semibold tracking-[-0.02em] text-[#24211f]">Create team</h2>
          </div>
          <button onClick={onClose} className="crm-icon-button" aria-label="Close">×</button>
        </div>
        <div className="px-5 py-4 space-y-4">
          {error && <div className="border border-[#e9caca] bg-[#fffafa] px-3 py-2 text-[11.5px] text-[#8d2727]">{error}</div>}
          <Field label="Team name *">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="engineering"
              className="crm-input w-full"
            />
            <div className="text-[11px] text-[#a3a3a3] mt-1">Letters, numbers, dashes, underscores only.</div>
          </Field>
          <div>
            <div className="dash-label mb-2">Members (optional)</div>
            {members.length > 0 && (
              <ul className="mb-3 space-y-1.5">
                {members.map((m, i) => (
                  <li key={i} className="flex items-center justify-between border border-[#e5e3df] bg-[#faf9f5] px-3 py-2 text-[11.5px]">
                    <span className="truncate">
                      <span className="font-medium">{m.name}</span>
                      <span className="text-[#737373] font-mono ml-2">+{m.phone}</span>
                    </span>
                    <button onClick={() => setMembers(arr => arr.filter((_, j) => j !== i))} className="text-[#a3a3a3] hover:text-black">×</button>
                  </li>
                ))}
              </ul>
            )}
            <div className="grid grid-cols-2 gap-2">
              <input
                value={memberName}
                onChange={(e) => setMemberName(e.target.value)}
                placeholder="Name"
                className="crm-input"
              />
              <input
                value={memberPhone}
                onChange={(e) => setMemberPhone(e.target.value)}
                placeholder="+91 98765 43210"
                className="crm-input"
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addRow(); } }}
              />
            </div>
            <button
              onClick={addRow}
              disabled={!memberName.trim() || !memberPhone.replace(/\D/g, "")}
              className="crm-button mt-2 disabled:opacity-40"
            >
              + Add
            </button>
            <div className="text-[11px] text-[#a3a3a3] mt-1">
              You&apos;re auto-added as admin. Members can join later from WhatsApp too.
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[#e5e3df] px-5 py-4">
          <button onClick={onClose} className="crm-button">Cancel</button>
          <button onClick={submit} disabled={busy || !name.trim()} className="crm-button crm-button-primary disabled:opacity-40">
            {busy ? "Creating…" : "Create team"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddMemberModal({
  open, onClose, teamName, onAdded,
}: { open: boolean; onClose: () => void; teamName: string; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) { setName(""); setPhone(""); setRole("member"); setError(null); }
  }, [open]);

  async function submit() {
    if (!name.trim() || !phone.replace(/\D/g, "")) { setError("Name + phone required"); return; }
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), phone: phone.replace(/\D/g, ""), role }),
      });
      const d = await r.json();
      if (!d.ok) { setError(d.error || "Could not add."); return; }
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  return (
    <div className="crm-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="add-team-member-title" onMouseDown={onClose}>
      <div onMouseDown={(e) => e.stopPropagation()} className="crm-modal max-w-[440px]">
        <div className="border-b border-[#e5e3df] px-5 py-4">
          <div className="crm-label">Team {displayTeamName(teamName)}</div>
          <h2 id="add-team-member-title" className="mt-1 text-[14px] font-semibold tracking-[-0.02em] text-[#24211f]">Add member</h2>
        </div>
        <div className="px-5 py-4 space-y-3">
          {error && <div className="border border-[#e9caca] bg-[#fffafa] px-3 py-2 text-[11.5px] text-[#8d2727]">{error}</div>}
          <Field label="Name *">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" className="crm-input w-full" />
          </Field>
          <Field label="Phone *">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" className="crm-input w-full" />
            <div className="text-[11px] text-[#a3a3a3] mt-1">They&apos;ll receive standup pings, polls, and announcements via WhatsApp.</div>
          </Field>
          <Field label="Role">
            <select value={role} onChange={(e) => setRole(e.target.value)} className="crm-select w-full">
              <option value="member">Member</option>
              <option value="lead">Lead</option>
              <option value="manager">Manager</option>
            </select>
          </Field>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-[#e5e3df] px-5 py-4">
          <button onClick={onClose} className="crm-button">Cancel</button>
          <button onClick={submit} disabled={busy} className="crm-button crm-button-primary disabled:opacity-40">
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MemberDetailModal({ teamName, member, onClose }: { teamName: string; member: Member; onClose: () => void }) {
  return (
    <div className="crm-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="member-detail-title" onMouseDown={onClose}>
      <div className="crm-modal max-w-[500px]" onMouseDown={event => event.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-[#e5e3df] px-5 py-4">
          <Avatar name={member.member_name || formatPhone(member.member_phone)} done={Boolean(member.last_standup_at)} />
          <div className="min-w-0 flex-1">
            <div className="crm-label">{displayTeamName(teamName)}</div>
            <h2 id="member-detail-title" className="mt-1 truncate text-[14px] font-semibold tracking-[-0.02em] text-[#24211f]">{member.member_name || formatPhone(member.member_phone)}</h2>
          </div>
          <RoleBadge role={member.role || "member"} />
        </div>
        <div className="grid sm:grid-cols-2">
          <DetailField label="Phone" value={formatPhone(member.member_phone)} mono />
          <DetailField label="Role" value={(member.role || "member").replace(/^./, char => char.toUpperCase())} />
          <DetailField label="Standup activity" value={member.last_standup_at ? `Last active ${fmtAgo(member.last_standup_at)}` : "No standup submitted yet"} />
          <DetailField label="Current streak" value={member.streak && member.streak > 0 ? `${member.streak} days` : "No active streak"} />
        </div>
        <div className="flex justify-end border-t border-[#e5e3df] px-5 py-4"><button className="crm-button" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

function DetailField({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="border-b border-[#eceae6] px-5 py-4 sm:border-r sm:last:border-r-0"><div className="crm-label">{label}</div><div className={`mt-1 text-[11.5px] text-[#3c3834] ${mono ? "font-mono" : ""}`}>{value}</div></div>;
}

function EditMemberModal({ teamName, member, onClose, onSaved, setError }: {
  teamName: string;
  member: Member;
  onClose: () => void;
  onSaved: () => void;
  setError: (value: string | null) => void;
}) {
  const [name, setName] = useState(member.member_name || "");
  const [role, setRole] = useState(member.role || "member");
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) { setValidation("A member name is required."); return; }
    setBusy(true);
    setValidation(null);
    try {
      const response = await fetch(`/api/team/${encodeURIComponent(teamName)}/members`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: member.member_phone, name: name.trim(), role }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || "Could not update this member.");
      onSaved();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Could not update this member.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="crm-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="edit-member-title" onMouseDown={onClose}>
      <div className="crm-modal max-w-[440px]" onMouseDown={event => event.stopPropagation()}>
        <div className="border-b border-[#e5e3df] px-5 py-4">
          <div className="crm-label">Team {displayTeamName(teamName)}</div>
          <h2 id="edit-member-title" className="mt-1 text-[14px] font-semibold tracking-[-0.02em] text-[#24211f]">Edit member</h2>
        </div>
        <div className="space-y-4 px-5 py-5">
          {validation ? <div className="border border-[#e9caca] bg-[#fffafa] px-3 py-2 text-[11.5px] text-[#8d2727]">{validation}</div> : null}
          <Field label="Name"><input value={name} onChange={event => setName(event.target.value)} className="crm-input w-full" /></Field>
          <Field label="Phone"><input value={formatPhone(member.member_phone)} disabled className="crm-input w-full bg-[#f7f6f2] text-[#77736f]" /></Field>
          <Field label="Role">
            <select value={role} onChange={event => setRole(event.target.value)} className="crm-select w-full" disabled={member.role === "admin"}>
              <option value="member">Member</option>
              <option value="lead">Lead</option>
              <option value="manager">Manager</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
        </div>
        <div className="flex justify-end gap-2 border-t border-[#e5e3df] px-5 py-4">
          <button className="crm-button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="crm-button crm-button-primary" onClick={() => void submit()} disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
        </div>
      </div>
    </div>
  );
}

// ─── Bits ──────────────────────────────────────────────────────────────

function BlockHeader({ accent, title, subtitle }: { accent: string; title: string; subtitle?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-[#e5e3df] px-5 py-4">
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: accent }} />
        <h3 className="crm-section-title">{title}</h3>
      </div>
      {subtitle && <span className="text-[10.5px] text-[#77736f]">{subtitle}</span>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="crm-label mb-1.5 block">{label}</label>
      {children}
    </div>
  );
}

function Avatar({ name, done }: { name: string; done: boolean }) {
  const initial = name.replace(/^\+/, "").charAt(0).toUpperCase();
  return (
    <div
      className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border text-[10.5px] font-semibold ${
        done ? "border-[#c9ded2] bg-[#f2faf5] text-[#096645]" : "border-[#dfddd7] bg-[#faf8ef] text-[#403a35]"
      }`}
    >
      {initial}
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  const normalized = role.toLowerCase();
  const green = normalized === "admin" || normalized === "manager";
  return <span className={`crm-status ${green ? "border-[#c9ded2] bg-[#f2faf5] text-[#096645]" : "border-[#deddd8] bg-[#f6f5f1] text-[#77736f]"}`}>{role.charAt(0).toUpperCase() + role.slice(1)}</span>;
}

function displayTeamName(value: string): string {
  return value.split(/[-_]/).filter(Boolean).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function teamInitials(value: string): string {
  const words = displayTeamName(value).split(" ");
  return words.slice(0, 2).map(word => word.charAt(0)).join("").toUpperCase() || "T";
}

function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits ? `+${digits}` : value;
}

function PlusIcon() { return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>; }
function TaskIcon() { return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2" stroke="currentColor" strokeWidth="1.2"/><path d="m5 8 2 2 4-4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function ImportPeopleIcon() { return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="6" cy="5.5" r="2" stroke="currentColor" strokeWidth="1.2"/><path d="M2.5 12c.4-2 1.6-3 3.5-3s3.1 1 3.5 3M11.5 4.5v5M9 7h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>; }
function SearchIcon() { return <svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#918d88]" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4" stroke="currentColor" strokeWidth="1.2"/><path d="m10 10 3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>; }
function EyeIcon() { return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.8 8s2.1-3.5 6.2-3.5S14.2 8 14.2 8 12.1 11.5 8 11.5 1.8 8 1.8 8Z" stroke="currentColor" strokeWidth="1.2"/><circle cx="8" cy="8" r="1.7" stroke="currentColor" strokeWidth="1.2"/></svg>; }
function EditIcon() { return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 11.8.4-2.7 6.8-6.8 2.5 2.5-6.8 6.8-2.9.2Z" stroke="currentColor" strokeWidth="1.15" strokeLinejoin="round"/><path d="m9.5 3 2.5 2.5" stroke="currentColor" strokeWidth="1.15"/></svg>; }
function TrashIcon() { return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 4.5h10M6 2.5h4M4.5 4.5l.6 8h5.8l.6-8M6.5 7v3.5M9.5 7v3.5" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round"/></svg>; }

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
function fmtRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const sf = s.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const ef = e.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return start === end ? sf : `${sf} → ${ef}`;
}
function fmtAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return `${months}mo ago`;
}
function severityColor(s: string): string {
  const k = (s || "").toLowerCase();
  if (k === "critical") return "#ef4444";
  if (k === "high") return "#F59E0B";
  if (k === "medium") return "#8A65FF";
  return "#a3a3a3";
}

// ─── Helper: refetch list and select a team ────────────────────────────

async function fetchTeamsAndSelect(
  preferredName: string,
  setTeams: (t: TeamRef[]) => void,
  setSelected: (n: string | null) => void,
  setError: (s: string | null) => void,
) {
  try {
    const r = await fetch("/api/team/list", { cache: "no-store" });
    const d = await r.json();
    if (!d.ok) { setError(d.error || "Could not refresh."); return; }
    setTeams(d.teams || []);
    setSelected(preferredName);
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  }
}
