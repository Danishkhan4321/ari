// dashboard/app/api/team/[name]/public/route.ts
//
// GET   — public-page settings for this team (admin only).
// PATCH — toggle public, set slug + tagline. Admin only.
import { NextResponse } from "next/server";
import { getCurrentUserPhone } from "@/lib/session";
import { resolveTeamAdmin } from "@/lib/sprint";
import { getPublicMeta, upsertPublicMeta } from "@/lib/team-meta";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { name: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });
    if (adminPhone !== userPhone) return NextResponse.json({ ok: false, error: "admin only" }, { status: 403 });
    const meta = (await getPublicMeta(adminPhone, teamName)) ?? { slug: null, public_enabled: false, tagline: null };
    return NextResponse.json({ ok: true, meta });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: { name: string } }) {
  try {
    const userPhone = await getCurrentUserPhone();
    if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
    const teamName = decodeURIComponent(params.name);
    const adminPhone = await resolveTeamAdmin(teamName, userPhone);
    if (!adminPhone) return NextResponse.json({ ok: false, error: "team not found" }, { status: 404 });
    if (adminPhone !== userPhone) return NextResponse.json({ ok: false, error: "admin only" }, { status: 403 });

    let body: { slug?: string | null; public_enabled?: boolean; tagline?: string | null } = {};
    try { body = await req.json(); } catch { /* validate */ }
    let slug = body.slug;
    if (slug !== undefined && slug !== null) {
      slug = slug.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
      if (!slug) return NextResponse.json({ ok: false, error: "slug invalid" }, { status: 400 });
    }
    await upsertPublicMeta(adminPhone, teamName, {
      slug: slug ?? null,
      public_enabled: body.public_enabled,
      tagline: body.tagline ?? null,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
