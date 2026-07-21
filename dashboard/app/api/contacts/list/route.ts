// dashboard/app/api/contacts/list/route.ts
// GET /api/contacts/list[?q=…&group=ID] — returns the user's sales leads
// and address-book contacts in two arrays. The page renders them as tabs.
//
// Each row is enriched with `groups: string[]` — the names of every
// contact_group it belongs to. Used in /contacts to show membership pills
// and in /contacts/pipeline to filter the kanban by group.
//
// `?group=<id>` filters both leads + contacts to ONLY members of that
// group. Used by the pipeline group selector.
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";
import { ensureCrmColumns } from "@/lib/crm";

export const dynamic = "force-dynamic";

export type Lead = {
  id: number;
  name: string;
  email: string | null;
  company: string | null;
  stage: string | null;
  deal_value: number | null;
  source: string | null;
  notes: string | null;
  title: string | null;
  phone: string | null;
  location: string | null;
  linkedin_url: string | null;
  website: string | null;
  company_domain: string | null;
  enrichment_status: string | null;
  enriched_at: string | null;
  archived_at: string | null;
  created_at: string | null;
  groups: string[];
};

export type AddressContact = {
  id: number;
  name: string;
  phone: string;
  category: string | null;
  notes: string | null;
  groups: string[];
};

export async function GET(req: Request) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  await ensureCrmColumns();

  // The investor-demo database runs in-memory, where the production query's
  // array aggregation is intentionally not emulated. Keep this response
  // explicit so demo mode remains isolated from normal customer data paths.
  if (process.env.ARI_DEMO_MODE === "true") {
    const leadRows = await query<Omit<Lead, "groups">>(
      `SELECT id, name, email, company, stage, deal_value, source, notes, title, phone,
              location, linkedin_url, website, company_domain, enrichment_status,
              enriched_at, archived_at, created_at
         FROM sales_leads WHERE user_phone = $1 ORDER BY id DESC`,
      [userPhone],
    );
    const contactRows = await query<Omit<AddressContact, "groups">>(
      `SELECT id, name, phone, category, notes FROM contacts WHERE user_phone = $1 ORDER BY name`,
      [userPhone],
    );
    const memberships = await query<{ member_kind: "lead" | "contact"; member_id: number; name: string }>(
      `SELECT m.member_kind, m.member_id, g.name FROM contact_group_members m
       JOIN contact_groups g ON g.id = m.group_id WHERE g.user_phone = $1`,
      [userPhone],
    );
    const groupsFor = (kind: "lead" | "contact", id: number) => memberships.rows.filter(row => row.member_kind === kind && Number(row.member_id) === Number(id)).map(row => row.name);
    return NextResponse.json({ ok: true, leads: leadRows.rows.map(row => ({ ...row, groups: groupsFor("lead", row.id) })), contacts: contactRows.rows.map(row => ({ ...row, groups: groupsFor("contact", row.id) })) });
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const term = `%${q}%`;
  const groupParam = url.searchParams.get("group");
  const groupId = groupParam ? Number(groupParam) : null;
  const filterByGroup = groupId !== null && Number.isInteger(groupId) && groupId > 0;

  // A table the bot has not lazily created yet (42P01) is a real empty state.
  // Any other database failure must surface as an error, never as an empty
  // list pretending to be data.
  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch (error) {
      if ((error as { code?: string })?.code === "42P01") return fallback;
      throw error;
    }
  };

  // Build the leads query. The LEFT JOIN with contact_group_members
  // attaches group names as an aggregated array. If `?group=<id>` is set,
  // we INNER JOIN instead so rows are filtered to that group's members.
  const leadsSql = filterByGroup
    ? `SELECT l.id, l.name, l.email, l.company, l.stage, l.deal_value, l.source, l.notes,
              l.title, l.phone, l.location, l.linkedin_url, l.website, l.company_domain, l.enrichment_status, l.enriched_at, l.archived_at, l.created_at,
              COALESCE(
                (SELECT array_agg(g.name ORDER BY g.name)
                   FROM contact_group_members m
                   JOIN contact_groups g ON g.id = m.group_id AND g.user_phone = $1
                  WHERE m.member_kind = 'lead' AND m.member_id = l.id),
                ARRAY[]::text[]
              ) AS groups
         FROM sales_leads l
         JOIN contact_group_members fm
              ON fm.member_kind = 'lead' AND fm.member_id = l.id AND fm.group_id = $${q ? 3 : 2}
        WHERE l.user_phone = $1
          ${q ? `AND (LOWER(l.name) LIKE $2 OR LOWER(COALESCE(l.email,'')) LIKE $2 OR LOWER(COALESCE(l.company,'')) LIKE $2)` : ""}
        ORDER BY l.id DESC LIMIT 500`
    : `SELECT l.id, l.name, l.email, l.company, l.stage, l.deal_value, l.source, l.notes,
              l.title, l.phone, l.location, l.linkedin_url, l.website, l.company_domain, l.enrichment_status, l.enriched_at, l.archived_at, l.created_at,
              COALESCE(
                (SELECT array_agg(g.name ORDER BY g.name)
                   FROM contact_group_members m
                   JOIN contact_groups g ON g.id = m.group_id AND g.user_phone = $1
                  WHERE m.member_kind = 'lead' AND m.member_id = l.id),
                ARRAY[]::text[]
              ) AS groups
         FROM sales_leads l
        WHERE l.user_phone = $1
          ${q ? `AND (LOWER(l.name) LIKE $2 OR LOWER(COALESCE(l.email,'')) LIKE $2 OR LOWER(COALESCE(l.company,'')) LIKE $2)` : ""}
        ORDER BY l.id DESC LIMIT 500`;

  const contactsSql = filterByGroup
    ? `SELECT c.id, c.name, c.phone, c.category, c.notes,
              COALESCE(
                (SELECT array_agg(g.name ORDER BY g.name)
                   FROM contact_group_members m
                   JOIN contact_groups g ON g.id = m.group_id AND g.user_phone = $1
                  WHERE m.member_kind = 'contact' AND m.member_id = c.id),
                ARRAY[]::text[]
              ) AS groups
         FROM contacts c
         JOIN contact_group_members fm
              ON fm.member_kind = 'contact' AND fm.member_id = c.id AND fm.group_id = $${q ? 3 : 2}
        WHERE c.user_phone = $1
          ${q ? `AND (LOWER(c.name) LIKE $2 OR c.phone LIKE $2)` : ""}
        ORDER BY c.name ASC LIMIT 500`
    : `SELECT c.id, c.name, c.phone, c.category, c.notes,
              COALESCE(
                (SELECT array_agg(g.name ORDER BY g.name)
                   FROM contact_group_members m
                   JOIN contact_groups g ON g.id = m.group_id AND g.user_phone = $1
                  WHERE m.member_kind = 'contact' AND m.member_id = c.id),
                ARRAY[]::text[]
              ) AS groups
         FROM contacts c
        WHERE c.user_phone = $1
          ${q ? `AND (LOWER(c.name) LIKE $2 OR c.phone LIKE $2)` : ""}
        ORDER BY c.name ASC LIMIT 500`;

  const leadsArgs: (string | number)[] = filterByGroup
    ? (q ? [userPhone, term, groupId!] : [userPhone, groupId!])
    : (q ? [userPhone, term] : [userPhone]);
  const contactsArgs: (string | number)[] = filterByGroup
    ? (q ? [userPhone, term, groupId!] : [userPhone, groupId!])
    : (q ? [userPhone, term] : [userPhone]);

  try {
    const [leads, contacts] = await Promise.all([
      safe(async () => (await query<Lead>(leadsSql, leadsArgs)).rows, [] as Lead[]),
      safe(async () => (await query<AddressContact>(contactsSql, contactsArgs)).rows, [] as AddressContact[]),
    ]);
    return NextResponse.json({ ok: true, leads, contacts });
  } catch (error) {
    const correlationId = crypto.randomUUID();
    console.error(`[contacts/list] ${correlationId} database failure:`, error);
    return NextResponse.json({ ok: false, error: "database_unavailable", correlationId }, { status: 503 });
  }
}
