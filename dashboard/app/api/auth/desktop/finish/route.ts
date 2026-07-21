import { NextResponse } from "next/server";
import { createDesktopAuthTicket } from "@/lib/desktop-auth";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

const BASE = (process.env.DASHBOARD_BASE_URL || "http://127.0.0.1:43101").replace(/\/+$/, "");

export async function GET() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.redirect(`${BASE}/login`, 303);
  const ticket = await createDesktopAuthTicket(userPhone);
  return NextResponse.redirect(`${BASE}/auth/desktop#ticket=${encodeURIComponent(ticket)}`, 303);
}
