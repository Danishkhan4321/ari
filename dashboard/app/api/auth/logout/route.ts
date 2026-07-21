// dashboard/app/api/auth/logout/route.ts
// POST → invalidates the session token in the DB and clears the cookie.
import { NextResponse } from "next/server";
import { clearSessionCookie, destroySession, readSessionCookie } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST() {
  await destroySession(readSessionCookie());
  clearSessionCookie();
  return NextResponse.redirect(new URL("/login", process.env.DASHBOARD_BASE_URL || "http://127.0.0.1:43101"), 303);
}
