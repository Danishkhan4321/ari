// dashboard/app/api/email/track/click/[token]/route.ts
//
// GET /api/email/track/click/<token>?u=<url-encoded-target>
//   Records a "click" for the email_sends row tied to <token>, then
//   302-redirects the browser to the target URL. Click signal is
//   stronger than opens — it's a real user action, not a side-effect
//   of the email client's image prefetch.
//
// Safety: the target URL must be http or https. Other schemes
// (javascript:, file:, data:) are rejected to prevent the click endpoint
// from being abused as an open redirector for phishing.
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { ensureEmailSendsTable } from "@/lib/email-tracking";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: { token: string } }) {
  const url = new URL(req.url);
  const target = url.searchParams.get("u") || "";

  // Validate the target before recording or redirecting. If the URL is
  // missing or malformed, send the browser to the dashboard instead of
  // failing — better than a dead link in someone's inbox.
  let safeTarget: string | null = null;
  try {
    if (target) {
      const u = new URL(target);
      if (u.protocol === "http:" || u.protocol === "https:") {
        safeTarget = u.toString();
      }
    }
  } catch {
    safeTarget = null;
  }
  if (!safeTarget) {
    return NextResponse.redirect(process.env.DASHBOARD_BASE_URL || new URL("/", req.url), { status: 302 });
  }

  // Best-effort tracking — never block the redirect on a DB hiccup.
  try {
    const token = (params.token || "").replace(/\.(gif|png)$/i, "");
    if (/^[a-f0-9]{16,64}$/i.test(token)) {
      await ensureEmailSendsTable();
      await query(
        `UPDATE email_sends
            SET click_count = click_count + 1,
                clicked_at = COALESCE(clicked_at, NOW()),
                last_clicked_at = NOW()
          WHERE tracking_token = $1`,
        [token]
      );
    }
  } catch {
    // Swallow.
  }

  // 302 Found — keeps the original URL recoverable on retry, doesn't
  // get cached by browsers as aggressively as 301.
  return NextResponse.redirect(safeTarget, { status: 302 });
}
