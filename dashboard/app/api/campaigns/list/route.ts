// dashboard/app/api/campaigns/list/route.ts
// GET — past bulk email campaigns owned by the user.
import { NextResponse } from "next/server";
import { listCampaigns } from "@/lib/groups";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });
  const campaigns = await listCampaigns(userPhone);
  return NextResponse.json({ ok: true, campaigns });
}
