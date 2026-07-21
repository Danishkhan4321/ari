import { NextResponse } from "next/server";
import { getCurrentUserPhone } from "@/lib/session";
import { callBotInternal } from "@/lib/bot-bridge";

export const dynamic = "force-dynamic";

const PRODUCTS = new Set(["all", "gmail", "calendar", "drive", "docs", "sheets", "slides", "tasks"]);

export async function POST(request: Request) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const product = typeof body.product === "string" ? body.product : "all";
  if (!PRODUCTS.has(product)) {
    return NextResponse.json({ ok: false, error: "invalid Google product" }, { status: 400 });
  }

  const result = await callBotInternal<{ url: string }>(
    "/webhook/internal/dashboard-google-connect",
    { user_phone: userPhone, product },
    30_000,
  );
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status || 502 });
  }
  return NextResponse.json({ ok: true, url: result.data.url });
}
