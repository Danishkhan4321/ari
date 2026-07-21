"use client";

// Setup checklist — surfaces on the empty Today tab. The single
// highest-leverage activation lever: SaaS benchmarks show teams
// reaching value in <5min retain at 85% vs 35% at 30+min.
//
// Tracks 4 first-time admin actions:
//   1. Add 5+ members
//   2. Configure a daily standup
//   3. Send first broadcast
//   4. Edit member birthdays (so celebrations work)
//
// Persists "dismissed" + "completed" state in localStorage so
// admins don't see it after they're set up.
import { useEffect, useState } from "react";
import Link from "next/link";
import { trackSync } from "@/lib/analytics";

type Member = { member_phone: string; member_name: string | null };

type ChecklistState = {
  membersAdded: boolean;        // ≥5 members in team
  standupConfigured: boolean;   // standup_configs row exists
  broadcastSent: boolean;       // ≥1 broadcast sent
  birthdaysSet: boolean;        // ≥1 team_member_meta row with birthday
};

export function SetupChecklist({
  teamName,
  isAdmin,
  members,
  hasStandup,
  onTabChange,
  onOpenBulkInvite,
}: {
  teamName: string;
  isAdmin: boolean;
  members: Member[];
  hasStandup: boolean;
  onTabChange: (tab: "broadcasts" | "settings") => void;
  onOpenBulkInvite: () => void;
}) {
  const dismissKey = `ari.setup-dismissed.${teamName}`;
  const [dismissed, setDismissed] = useState(true); // default true so it doesn't flash before localStorage hydrates
  const [state, setState] = useState<ChecklistState>({
    membersAdded: false,
    standupConfigured: false,
    broadcastSent: false,
    birthdaysSet: false,
  });

  useEffect(() => {
    // Only admins see this, and only if not dismissed
    setDismissed(typeof window !== "undefined" && localStorage.getItem(dismissKey) === "1");
  }, [dismissKey]);

  // Compute live state from API — counts members directly, asks the
  // server for the rest in one round-trip.
  useEffect(() => {
    if (!isAdmin) return;
    (async () => {
      try {
        const r = await fetch(`/api/team/${encodeURIComponent(teamName)}/setup-status`, { cache: "no-store" });
        const d = await r.json();
        if (d.ok) {
          setState({
            membersAdded: members.length >= 5,
            standupConfigured: hasStandup,
            broadcastSent: !!d.broadcast_sent,
            birthdaysSet: !!d.birthdays_set,
          });
        } else {
          // fall back: at least show member-count progress
          setState(s => ({ ...s, membersAdded: members.length >= 5, standupConfigured: hasStandup }));
        }
      } catch {
        setState(s => ({ ...s, membersAdded: members.length >= 5, standupConfigured: hasStandup }));
      }
    })();
  }, [teamName, isAdmin, members.length, hasStandup]);

  if (!isAdmin || dismissed) return null;

  const items: { key: keyof ChecklistState; title: string; sub: string; cta: string; action: () => void }[] = [
    {
      key: "membersAdded",
      title: "Add at least 5 teammates",
      sub: `${members.length} added so far. Standups, polls, broadcasts all need members to be useful.`,
      cta: "+ Bulk invite",
      action: onOpenBulkInvite,
    },
    {
      key: "standupConfigured",
      title: "Configure your daily standup",
      sub: "Tell Ari: \"create standup for " + teamName + ": what did you do, what will you do, blockers?\"",
      cta: "Open chat",
      action: () => { window.location.href = "/chat"; },
    },
    {
      key: "broadcastSent",
      title: "Send your first announcement",
      sub: "One message to the whole team via WhatsApp. See who reads it.",
      cta: "Send broadcast",
      action: () => onTabChange("broadcasts"),
    },
    {
      key: "birthdaysSet",
      title: "Add birthdays + work anniversaries",
      sub: "Ari auto-celebrates with a team broadcast at 9am on the day.",
      cta: "Add dates",
      action: () => onTabChange("settings"),
    },
  ];

  const completedCount = items.filter(i => state[i.key]).length;
  const allDone = completedCount === items.length;

  if (allDone) {
    // Auto-dismiss when all 5 are done
    if (typeof window !== "undefined") localStorage.setItem(dismissKey, "1");
    return null;
  }

  function dismiss() {
    if (typeof window !== "undefined") localStorage.setItem(dismissKey, "1");
    setDismissed(true);
    trackSync("setup_checklist_dismissed", { team: teamName, completed: completedCount });
  }

  return (
    <section className="dash-card-hero p-5 mb-5 relative">
      <button
        onClick={dismiss}
        className="absolute top-3 right-3 text-[#a3a3a3] hover:text-[#0a0a0a] text-[18px] leading-none"
        aria-label="Dismiss"
        title="Dismiss"
      >
        ×
      </button>
      <div className="dash-label mb-2 flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-[#D8CCFF]" />
        Setup · {completedCount}/{items.length} done
      </div>
      <h3 className="dash-h2 mb-1">Get your team running in 5 minutes</h3>
      <p className="text-[12.5px] text-[#737373] mb-4">
        Most SMB teams that hit value in under 5 minutes stay around. We&apos;ll keep this hidden once everything below is done.
      </p>

      {/* Progress bar */}
      <div className="h-1.5 rounded-full bg-[#E8E3ED] overflow-hidden mb-5">
        <div
          className="h-full bg-[#3FAA6E] transition-all"
          style={{ width: `${(completedCount / items.length) * 100}%` }}
        />
      </div>

      <ul className="space-y-2">
        {items.map(it => {
          const done = state[it.key];
          return (
            <li
              key={it.key}
              className={`flex items-start gap-3 p-3 rounded-md border transition-colors ${
                done
                  ? "bg-[#D8CCFF]/15 border-[#3FAA6E]/30"
                  : "bg-white border-[#E8E3ED] hover:border-[#0a0a0a]"
              }`}
            >
              <div
                className={`mt-0.5 w-5 h-5 rounded-full border flex items-center justify-center flex-shrink-0 ${
                  done ? "bg-[#3FAA6E] border-[#3FAA6E]" : "border-[#a3a3a3]"
                }`}
              >
                {done && (
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                    <path d="M3 8.5l3 3 7-7" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className={`text-[13.5px] font-medium ${done ? "text-[#3FAA6E] line-through" : "text-[#0a0a0a]"}`}>
                  {it.title}
                </div>
                <div className="text-[11.5px] text-[#737373] mt-0.5 leading-relaxed">{it.sub}</div>
              </div>
              {!done && (
                <button
                  onClick={() => { trackSync("setup_checklist_action", { step: it.key, team: teamName }); it.action(); }}
                  className="dash-btn !text-[11.5px] !py-1 !px-2.5 flex-shrink-0"
                >
                  {it.cta}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <div className="text-[10.5px] text-[#a3a3a3] mt-4 text-center">
        Hidden once everything is done · <button onClick={dismiss} className="underline hover:text-[#0a0a0a]">hide for good</button>
      </div>
    </section>
  );
}

// Public Link helper consumers can use too — keeps router imports
// localized to this file.
export { Link };
