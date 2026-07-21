// dashboard/app/api/me/route.ts
// GET — minimal "who am I" profile for the sidebar account block.
// Returns the signed-in user's phone, Google email (if connected),
// and the best display name we have.
//
// Name resolution, in order:
//   1. memory_trunk personal/name — what the user explicitly told
//      Ari in chat ("my name is Rohan", "call me Priya"). Highest
//      priority because it's the user's stated preference, not what
//      their Google account or WhatsApp profile happens to say.
//   2. google_tokens.google_name — captured on OAuth callback (the
//      user's actual Google profile name)
//   3. public.users.name — the bot writes WhatsApp profile names here
//   4. Email local-part prettified ("dk557876" → "Dk557876")
//   5. "+<phone>"
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) return NextResponse.json({ ok: false, error: "not signed in" }, { status: 401 });

  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch { return fallback; }
  };

  const identity = await safe(async () =>
    (await query<{ email: string | null; display_name: string | null }>(
      `SELECT email, display_name FROM ari_user_identities
        WHERE user_phone = $1 AND provider = 'google' LIMIT 1`,
      [userPhone]
    )).rows[0] ?? null
  , null as { email: string | null; display_name: string | null } | null);

  // Fetch google_email AND google_name (column may not exist on older
  // deploys; the catch will swallow that).
  const google = await safe(async () =>
    (await query<{ google_email: string | null; google_name: string | null }>(
      `SELECT google_email, google_name FROM google_tokens WHERE user_phone = $1 LIMIT 1`,
      [userPhone]
    )).rows[0] ?? null
  , null as { google_email: string | null; google_name: string | null } | null);

  // If google_name column doesn't exist yet, retry without it.
  let googleEmail: string | null = google?.google_email ?? identity?.email ?? null;
  let googleName: string | null = google?.google_name ?? identity?.display_name ?? null;
  if (!google) {
    const fallback = await safe(async () =>
      (await query<{ google_email: string | null }>(
        `SELECT google_email FROM google_tokens WHERE user_phone = $1 LIMIT 1`,
        [userPhone]
      )).rows[0] ?? null
    , null);
    if (fallback) {
      googleEmail = fallback.google_email || identity?.email || null;
    }
  }

  // public.users.name — the bot stores WhatsApp profile names here.
  const profileName = await safe(async () =>
    (await query<{ name: string | null }>(
      `SELECT name FROM public.users WHERE phone_number = $1 LIMIT 1`,
      [userPhone]
    )).rows[0]?.name ?? null
  , null);

  // memory_trunk — what the user explicitly told Ari in chat
  // ("my name is Rohan" / "call me Priya"). Stored by memory.service.js
  // under category='personal', key_name='name' (or older variants).
  // Most-recently-updated wins so a later "actually call me X" overrides.
  const memoryName = await safe(async () =>
    (await query<{ value: string | null }>(
      `SELECT value FROM memory_trunk
        WHERE user_phone = $1
          AND category = 'personal'
          AND key_name IN ('name', 'preferred_name', 'first_name')
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
        LIMIT 1`,
      [userPhone]
    )).rows[0]?.value ?? null
  , null);

  const tier = await safe(async () =>
    (await query<{ tier: string | null }>(
      `SELECT tier FROM pending_onboarding
        WHERE phone = $1 AND status = 'completed'
        ORDER BY id DESC LIMIT 1`,
      [userPhone]
    )).rows[0]?.tier ?? null
  , null);

  // Pick the best display name. Chat-told name beats OAuth name —
  // explicit user intent ("call me X") trumps whatever their Google
  // account happens to display.
  const name =
    (memoryName && memoryName.trim()) ||
    (googleName && googleName.trim()) ||
    (profileName && profileName.trim()) ||
    (googleEmail ? prettify(googleEmail.split("@")[0]) : null) ||
    `+${userPhone}`;

  return NextResponse.json({
    ok: true,
    user_phone: userPhone,
    name,
    email: googleEmail,
    tier, // "cub" | "pack" | "alpha" | null
  });
}

// "dk557876" → "Dk557876"; "first.last" → "First Last"
function prettify(raw: string): string {
  return raw
    .replace(/[._-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
