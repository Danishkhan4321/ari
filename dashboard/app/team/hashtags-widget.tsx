"use client";

// Hashtags widget — sits on Today, shows what the team is rallying
// around this week. Filled by `#tag` mentions in WhatsApp messages
// (tracked by the bot's text-commands service).
//
// No tab, no settings, no schema for the user to manage. The team
// just types hashtags in their normal chat — the widget surfaces
// what's organically getting attention.
import { useEffect, useState } from "react";

type HashtagRow = { tag: string; mentions: number; contributors: number; last_seen: string };

export function HashtagsWidget({ teamName }: { teamName: string }) {
  const [tags, setTags] = useState<HashtagRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/team/${encodeURIComponent(teamName)}/hashtags`, { cache: "no-store" })
      .then(r => r.json())
      .then((d: { ok: boolean; this_week?: HashtagRow[] }) => {
        if (!cancelled && d.ok) setTags(d.this_week || []);
      })
      .catch(() => { /* silent */ });
    return () => { cancelled = true; };
  }, [teamName]);

  if (!tags || tags.length === 0) return null;

  return (
    <section className="dash-card overflow-hidden">
      <div className="px-5 py-4 border-b border-[#E8E3ED] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-[#9F7BD3]" />
          <h3 className="dash-h2">This week, the team is on…</h3>
        </div>
        <span className="text-[11px] text-[#737373]">{tags.length} {tags.length === 1 ? "topic" : "topics"}</span>
      </div>
      <ul className="px-5 py-3 flex flex-wrap gap-2">
        {tags.map(t => (
          <li key={t.tag}>
            <span
              className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-[#9F7BD3]/15 border border-[#9F7BD3]/40 rounded-full text-[12.5px]"
              title={`${t.contributors} ${t.contributors === 1 ? "person" : "people"} mentioning · last seen ${fmtAgo(t.last_seen)}`}
            >
              <span className="font-mono font-semibold">#{t.tag}</span>
              <span className="text-[10.5px] text-[#737373] num">{t.mentions}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="px-5 pb-3 text-[11px] text-[#a3a3a3]">
        Just type <span className="font-mono">#anything</span> in WhatsApp to add to this list. Single source of truth: chat itself.
      </div>
    </section>
  );
}

function fmtAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
