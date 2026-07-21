// dashboard/app/p/[slug]/page.tsx
//
// Public team page. No auth — driven entirely by the team_public_meta
// slug. Shows ONLY sanitized, aggregate data: team size, sprint
// progress %, pulse trend (no member-level data), recent kudos count.
// Acts as a landing page admins can share + we get a viral surface.
import { notFound } from "next/navigation";
import { resolveSlug } from "@/lib/team-meta";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

type SprintTotals = { name: string; progress: number; days_left: number | null } | null;

async function loadPublic(slug: string) {
  const team = await resolveSlug(slug);
  if (!team) return null;
  const adminPhone = team.admin_phone;
  const teamName = team.team_name;

  // Member count + recent activity, all aggregate.
  const [memCnt, sprint, pulseAvg, kudosCnt] = await Promise.all([
    query<{ count: string | number }>(
      `SELECT COUNT(*)::int AS count FROM teams WHERE admin_phone = $1 AND team_name = $2`,
      [adminPhone, teamName]
    ).catch(() => ({ rows: [{ count: 0 }] })),
    (async (): Promise<SprintTotals> => {
      try {
        const sR = await query<{ name: string; end_date: string | null }>(
          `SELECT name, end_date::text FROM sprints WHERE team_admin_phone = $1 AND status = 'active' ORDER BY id DESC LIMIT 1`,
          [adminPhone]
        );
        const s = sR.rows[0];
        if (!s) return null;
        const it = await query<{ status: string; story_points: number }>(
          `SELECT status, story_points FROM sprint_items WHERE sprint_id = (SELECT id FROM sprints WHERE team_admin_phone = $1 AND status = 'active' ORDER BY id DESC LIMIT 1)`,
          [adminPhone]
        );
        let total = 0, done = 0;
        for (const r of it.rows) {
          const p = Number(r.story_points) || 0;
          total += p;
          if (r.status === "done") done += p;
        }
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const daysLeft = s.end_date ? Math.max(0, Math.ceil((new Date(s.end_date).getTime() - Date.now()) / 86_400_000)) : null;
        return { name: s.name, progress: pct, days_left: daysLeft };
      } catch { return null; }
    })(),
    query<{ avg: string | number; n: string | number }>(
      `SELECT AVG(score)::numeric(4,2) AS avg, COUNT(*)::int AS n FROM team_pulse
        WHERE admin_phone = $1
          AND week_start >= CURRENT_DATE - INTERVAL '8 weeks'
          AND score IS NOT NULL`,
      [adminPhone]
    ).catch(() => ({ rows: [{ avg: 0, n: 0 }] })),
    query<{ count: string | number }>(
      `SELECT COUNT(*)::int AS count FROM team_kudos
        WHERE team_admin_phone = $1 AND created_at > NOW() - INTERVAL '30 days'`,
      [adminPhone]
    ).catch(() => ({ rows: [{ count: 0 }] })),
  ]);

  return {
    teamName,
    tagline: team.tagline,
    memberCount: Number(memCnt.rows[0]?.count || 0),
    sprint,
    pulseAvg: Number(pulseAvg.rows[0]?.avg || 0),
    pulseN: Number(pulseAvg.rows[0]?.n || 0),
    kudosCount: Number(kudosCnt.rows[0]?.count || 0),
  };
}

export default async function PublicTeamPage({ params }: { params: { slug: string } }) {
  const data = await loadPublic(params.slug);
  if (!data) notFound();

  return (
    <main className="min-h-screen bg-[#FBFAFE]">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <header className="mb-10">
          <a href="/" className="dash-label inline-flex items-center gap-2 text-[#737373] hover:text-[#0a0a0a] transition-colors">
            <span className="w-1.5 h-1.5 rounded-full bg-[#D8CCFF]" />
            Powered by Ari
          </a>
          <h1 className="dash-h1 text-[36px] mt-3 break-words">{data.teamName}</h1>
          {data.tagline && (
            <p className="text-[16px] text-[#525252] mt-3 leading-relaxed max-w-xl">
              {data.tagline}
            </p>
          )}
          <div className="text-[13px] text-[#737373] mt-3">
            {data.memberCount} {data.memberCount === 1 ? "member" : "members"}
          </div>
        </header>

        <section className="grid sm:grid-cols-3 gap-3 mb-8">
          <Stat label="Active sprint" value={data.sprint ? `${data.sprint.progress}%` : "—"} sub={data.sprint?.name} />
          <Stat label="Team pulse (8w avg)" value={data.pulseAvg > 0 ? `${data.pulseAvg.toFixed(1)}/5` : "—"} sub={data.pulseN > 0 ? `${data.pulseN} responses` : undefined} />
          <Stat label="Kudos (30d)" value={String(data.kudosCount)} sub={data.kudosCount === 1 ? "one shoutout" : `${data.kudosCount} shoutouts`} />
        </section>

        {data.sprint && data.sprint.days_left !== null && (
          <section className="dash-card-hero p-5 mb-8">
            <div className="dash-label mb-2">Active sprint</div>
            <div className="text-[18px] font-semibold mb-1">{data.sprint.name}</div>
            <div className="text-[13px] text-[#737373] mb-3">
              {data.sprint.days_left === 0 ? "ends today" : `${data.sprint.days_left} days remaining`}
            </div>
            <div className="h-2 rounded-full bg-[#E8E3ED] overflow-hidden">
              <div className="h-full bg-[#3FAA6E]" style={{ width: `${data.sprint.progress}%` }} />
            </div>
            <div className="text-right text-[12px] text-[#737373] mt-1.5 num">{data.sprint.progress}% done</div>
          </section>
        )}

        <footer className="mt-16 pt-8 border-t border-[#E8E3ED] text-center">
          <div className="text-[13px] text-[#737373] mb-4">
            <strong>{data.teamName}</strong> runs on Ari — the WhatsApp-native operating system for small teams.
          </div>
          <a href="/" className="dash-btn dash-btn-primary inline-flex">
            Try Ari for your team
          </a>
        </footer>
      </div>
    </main>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="dash-card p-4">
      <div className="dash-label mb-1">{label}</div>
      <div className="text-[24px] font-bold num leading-none">{value}</div>
      {sub && <div className="text-[11px] text-[#a3a3a3] mt-1.5 truncate">{sub}</div>}
    </div>
  );
}
