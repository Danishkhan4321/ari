// dashboard/app/api/team/[name]/today/route.ts
//
// GET — single-shot payload for the team's "Today" hub:
//   - team meta + your role
//   - members list with each member's last standup submission
//   - today's standup status: per-member latest answers (or "waiting")
//   - active polls in this team with vote tallies + your vote
//   - leave on today
//   - open incidents
//
// One round-trip so the page renders fast. Each query is independently
// safe-wrapped — if any sub-query fails (e.g. table missing), that
// section comes back empty rather than the whole page erroring.
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { name: string } }) {
  try {
    return await handleGet(req, params);
  } catch {
    // Belt-and-suspenders: any unhandled error returns a JSON 500 so the
    // client doesn't choke on an empty body trying to parse JSON.
    return NextResponse.json({ ok: false, error: "Could not load the team overview." }, { status: 500 });
  }
}

async function handleGet(_req: Request, params: { name: string }) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  const teamName = decodeURIComponent(params.name).toLowerCase();

  // 1. Resolve team admin (could be the user OR somebody else who shares it with them)
  // Postgres won't accept `DISTINCT … ORDER BY <expr>` unless the expr is
  // in the SELECT list, so we just LIMIT 1 with the priority sort instead.
  const ownerRes = await query<{ admin_phone: string }>(
    `SELECT admin_phone FROM teams
      WHERE team_name = $1
        AND (admin_phone = $2 OR member_phone = $2)
      ORDER BY (admin_phone = $2) DESC, id ASC
      LIMIT 1`,
    [teamName, userPhone]
  );
  const owner = ownerRes.rows[0]?.admin_phone;
  if (!owner) {
    return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });
  }
  const isAdmin = owner === userPhone;

  if (process.env.ARI_DEMO_MODE === "true") {
    const demoMembers = await query<{
      id: number;
      member_phone: string;
      member_name: string | null;
      role: string | null;
    }>(
      `SELECT id, member_phone, member_name, role
         FROM teams
        WHERE team_name = $1 AND admin_phone = $2
        ORDER BY member_name`,
      [teamName, owner],
    );
    const now = new Date().toISOString();
    const members = demoMembers.rows.map((member, index) => ({ ...member, last_standup_at: index < 2 ? now : null, streak: index === 0 ? 8 : index === 1 ? 5 : 0 }));
    const demoPolls = await query<{
      id: number; question: string; options: string[]; created_at: string; deadline: string | null;
      is_anonymous: boolean; multi_select: boolean; status: string; creator_phone: string;
    }>(`SELECT id, question, options, created_at, deadline, is_anonymous, multi_select, status, creator_phone FROM polls WHERE team_name = $1 AND status = 'active' ORDER BY id DESC`, [teamName]);
    const demoVotes = await query<{ poll_id: number; selected_option: number; voter_phone: string }>(`SELECT poll_id, selected_option, voter_phone FROM poll_votes`);
    const polls = demoPolls.rows.map(poll => {
      const options = Array.isArray(poll.options) ? poll.options : [];
      const votes = demoVotes.rows.filter(vote => Number(vote.poll_id) === Number(poll.id));
      return {
        ...poll,
        options,
        counts: options.map((_, index) => votes.filter(vote => vote.selected_option === index).length),
        your_vote: votes.find(vote => vote.voter_phone === userPhone)?.selected_option ?? null,
        total_votes: votes.length,
      };
    });
    const leaveToday = (await query(`SELECT id, employee_phone, employee_name, leave_type, start_date, end_date, status, half_day, half_day_period, reason FROM leave_requests ORDER BY id DESC`)).rows;
    const incidents = (await query(`SELECT id, title, description, severity, status, reported_by_name, assigned_to_name, created_at FROM incidents WHERE team_admin_phone = $1 AND status NOT IN ('resolved', 'closed') ORDER BY id DESC`, [owner])).rows;
    const submittedMembers = members.slice(0, 2);
    return NextResponse.json({
      ok: true,
      team: { name: teamName, admin_phone: owner, is_admin: isAdmin, member_count: members.length },
      members,
      standup: {
        config: { id: 1, name: "Daily product standup", questions: ["What did you complete?", "What is next?", "Any blockers?"], schedule_days: "weekdays", is_active: true },
        perMember: members.map((member, index) => ({
          member_phone: member.member_phone,
          member_name: member.member_name,
          submitted: index < 2,
          submitted_at: index < 2 ? now : null,
          answers: index === 0
            ? [{ question: "What did you complete?", answer: "Finished the CRM interaction QA and consolidated launch feedback." }, { question: "What is next?", answer: "Review the Team workspace and prepare the demo flow." }, { question: "Any blockers?", answer: "None." }]
            : index === 1
              ? [{ question: "What did you complete?", answer: "Updated onboarding copy and the partner launch checklist." }, { question: "What is next?", answer: "Polish the customer demo narrative." }, { question: "Any blockers?", answer: "Waiting on the final security overview." }]
              : [],
        })),
        submitted_count: submittedMembers.length,
        waiting_count: members.length - submittedMembers.length,
      },
      polls,
      leaveToday,
      incidents,
    });
  }

  // Sections still degrade independently so one broken table cannot blank the
  // whole Today hub — but a real database failure is now visible: it is
  // logged with a correlation id and reported in `degraded`, instead of
  // silently posing as an empty section. 42P01 (table not created yet by the
  // bot) stays a genuine empty state.
  const degraded: string[] = [];
  const correlationId = crypto.randomUUID();
  const section = (name: string) => async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch (error) {
      if ((error as { code?: string })?.code !== "42P01") {
        degraded.push(name);
        console.error(`[team/today] ${correlationId} section '${name}' failed:`, error);
      }
      return fallback;
    }
  };
  // 2. Members list (with last standup activity per member, in this team)
  const members = await section("members")(async () => (await query<{
    id: number; member_phone: string; member_name: string | null; role: string | null;
    last_standup_at: string | null;
    streak: number | null;
  }>(
    `SELECT
       t.id, t.member_phone, t.member_name, t.role,
       (SELECT MAX(sr.created_at)::text FROM standup_responses sr
          JOIN standup_configs sc ON sc.id = sr.config_id
         WHERE sc.team_name = t.team_name
           AND sc.admin_phone = t.admin_phone
           AND sr.member_phone = t.member_phone
           AND sr.answer != '__placeholder__'
       ) AS last_standup_at,
       (SELECT MAX(sr.response_streak) FROM standup_responses sr
          JOIN standup_configs sc ON sc.id = sr.config_id
         WHERE sc.team_name = t.team_name
           AND sc.admin_phone = t.admin_phone
           AND sr.member_phone = t.member_phone
       ) AS streak
       FROM teams t
      WHERE t.team_name = $1 AND t.admin_phone = $2
      ORDER BY t.member_name ASC`,
    [teamName, owner]
  )).rows, [] as {
    id: number; member_phone: string; member_name: string | null; role: string | null;
    last_standup_at: string | null; streak: number | null;
  }[]);

  // 3. Today's standup. Find the active config for this team (if any).
  type StandupQuestion = string;
  type StandupConfig = {
    id: number;
    name: string;
    questions: StandupQuestion[];
    schedule_days: string | null;
    is_active: boolean;
  };
  const config = await section("standup")(async () => (await query<{
    id: number; name: string; questions: unknown; schedule_days: string | null; is_active: boolean;
  }>(
    `SELECT id, name, questions, schedule_days, is_active
       FROM standup_configs
      WHERE team_name = $1 AND admin_phone = $2
        AND is_active = true
      ORDER BY id DESC LIMIT 1`,
    [teamName, owner]
  )).rows[0] ?? null, null as { id: number; name: string; questions: unknown; schedule_days: string | null; is_active: boolean } | null);

  let standup: {
    config: StandupConfig | null;
    perMember: {
      member_phone: string;
      member_name: string | null;
      submitted: boolean;
      answers: { question: string; answer: string }[];
      submitted_at: string | null;
    }[];
    submitted_count: number;
    waiting_count: number;
  } = { config: null, perMember: [], submitted_count: 0, waiting_count: 0 };

  if (config) {
    const questions: StandupQuestion[] = Array.isArray(config.questions)
      ? (config.questions as StandupQuestion[])
      : [];

    // Pull all of today's responses for this config in one go
    const todayRes = await section("standup")(async () => (await query<{
      member_phone: string;
      question_index: number;
      answer: string;
      created_at: string;
    }>(
      `SELECT member_phone, question_index, answer, created_at
         FROM standup_responses
        WHERE config_id = $1
          AND response_date = CURRENT_DATE
        ORDER BY member_phone, question_index`,
      [config.id]
    )).rows, [] as { member_phone: string; question_index: number; answer: string; created_at: string }[]);

    // Bucket by member
    const byMember = new Map<string, { answers: { question: string; answer: string }[]; submitted_at: string | null }>();
    for (const r of todayRes) {
      if (r.answer === "__placeholder__") continue;
      const cur = byMember.get(r.member_phone) || { answers: [], submitted_at: null };
      const q = questions[r.question_index] || `Q${r.question_index + 1}`;
      cur.answers.push({ question: q, answer: r.answer });
      if (!cur.submitted_at || r.created_at > cur.submitted_at) cur.submitted_at = r.created_at;
      byMember.set(r.member_phone, cur);
    }

    const perMember = members.map(m => {
      const sub = byMember.get(m.member_phone);
      return {
        member_phone: m.member_phone,
        member_name: m.member_name,
        submitted: Boolean(sub && sub.answers.length > 0),
        answers: sub?.answers ?? [],
        submitted_at: sub?.submitted_at ?? null,
      };
    });

    standup = {
      config: {
        id: config.id,
        name: config.name,
        questions,
        schedule_days: config.schedule_days,
        is_active: config.is_active,
      },
      perMember,
      submitted_count: perMember.filter(p => p.submitted).length,
      waiting_count: perMember.filter(p => !p.submitted).length,
    };
  }

  // 4. Active polls scoped to this team
  type PollOption = string;
  type Poll = {
    id: number; question: string; options: PollOption[];
    created_at: string; deadline: string | null; is_anonymous: boolean;
    multi_select: boolean; status: string;
    creator_phone: string;
    counts: number[];
    your_vote: number | null;
    total_votes: number;
  };
  const polls = await section("polls")(async () => {
    const ps = (await query<{
      id: number; question: string; options: unknown;
      created_at: string; deadline: string | null;
      is_anonymous: boolean; multi_select: boolean | null;
      status: string; creator_phone: string;
    }>(
      `SELECT id, question, options, created_at, deadline,
              is_anonymous, multi_select, status, creator_phone
         FROM polls
        WHERE team_name = $1
          AND status = 'active'
        ORDER BY id DESC LIMIT 20`,
      [teamName]
    )).rows;
    if (ps.length === 0) return [] as Poll[];
    const ids = ps.map(p => p.id);
    const votes = (await query<{ poll_id: number; selected_option: number; voter_phone: string }>(
      `SELECT poll_id, selected_option, voter_phone
         FROM poll_votes
        WHERE poll_id = ANY($1::int[])`,
      [ids]
    )).rows;
    return ps.map(p => {
      const opts = (Array.isArray(p.options) ? p.options as PollOption[] : []);
      const counts = new Array(opts.length).fill(0);
      let yourVote: number | null = null;
      for (const v of votes.filter(x => x.poll_id === p.id)) {
        if (v.selected_option >= 0 && v.selected_option < counts.length) counts[v.selected_option]++;
        if (v.voter_phone === userPhone) yourVote = v.selected_option;
      }
      return {
        id: p.id, question: p.question, options: opts,
        created_at: p.created_at, deadline: p.deadline,
        is_anonymous: Boolean(p.is_anonymous),
        multi_select: Boolean(p.multi_select),
        status: p.status, creator_phone: p.creator_phone,
        counts, your_vote: yourVote,
        total_votes: counts.reduce((a, b) => a + b, 0),
      };
    });
  }, [] as Poll[]);

  // 5. Leave today. Pending OR currently active. Scoped to team members.
  const memberPhones = members.map(m => m.member_phone);
  const leaveToday = await section("leave")(async () => {
    if (memberPhones.length === 0) return [] as {
      id: number; employee_phone: string; employee_name: string | null;
      leave_type: string; start_date: string; end_date: string;
      status: string; half_day: boolean; half_day_period: string | null;
      reason: string | null;
    }[];
    const r = await query<{
      id: number; employee_phone: string; leave_type: string;
      start_date: string; end_date: string; status: string;
      half_day: boolean; half_day_period: string | null; reason: string | null;
    }>(
      `SELECT id, employee_phone, leave_type, start_date, end_date,
              status, half_day, half_day_period, reason
         FROM leave_requests
        WHERE employee_phone = ANY($1::text[])
          AND (
            (status = 'approved' AND start_date <= CURRENT_DATE AND end_date >= CURRENT_DATE)
            OR status = 'pending'
          )
        ORDER BY status DESC, start_date ASC LIMIT 50`,
      [memberPhones]
    );
    const phoneToName = new Map(members.map(m => [m.member_phone, m.member_name]));
    return r.rows.map(x => ({ ...x, employee_name: phoneToName.get(x.employee_phone) ?? null }));
  }, []);

  // 6. Open incidents (admin-scoped)
  const incidents = await section("incidents")(async () => (await query<{
    id: number; title: string; description: string | null; severity: string;
    status: string; reported_by_name: string | null;
    assigned_to_name: string | null; created_at: string;
  }>(
    `SELECT id, title, description, severity, status,
            reported_by_name, assigned_to_name, created_at
       FROM incidents
      WHERE team_admin_phone = $1
        AND status NOT IN ('resolved', 'closed')
      ORDER BY
        CASE severity
          WHEN 'critical' THEN 1 WHEN 'high' THEN 2
          WHEN 'medium' THEN 3 WHEN 'low' THEN 4
          ELSE 5 END ASC,
        id DESC
      LIMIT 50`,
    [owner]
  )).rows, []);

  return NextResponse.json({
    ok: true,
    team: {
      name: teamName,
      admin_phone: owner,
      is_admin: isAdmin,
      member_count: members.length,
    },
    members,
    standup,
    polls,
    leaveToday,
    incidents,
    degraded: [...new Set(degraded)],
    ...(degraded.length > 0 ? { correlationId } : {}),
  });
}
