import { NextResponse } from "next/server";
import { resolveEmailIdentity, normalizeEmail, isValidEmail } from "@/lib/email-identity";
import { createSession, setSessionCookie } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { email?: string; name?: string } = {};
  try {
    body = (await req.json()) as { email?: string; name?: string };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid request" }, { status: 400 });
  }

  const email = normalizeEmail(body.email || "");
  if (!isValidEmail(email)) {
    return NextResponse.json({ ok: false, error: "Enter a valid email address." }, { status: 400 });
  }

  const userPhone = await resolveEmailIdentity({ email, name: body.name });
  const token = await createSession(userPhone);
  setSessionCookie(token);
  return NextResponse.json(
    { ok: true, redirect: "/" },
    { headers: { "cache-control": "no-store" } },
  );
}
