// dashboard/app/api/email/track/open/[token]/route.ts
//
// GET /api/email/track/open/<token>.gif
//   Records an "open" for the email_sends row tied to <token> and
//   returns a 1×1 transparent GIF so the email client renders nothing.
//
// Caveats (kept honest in the UI):
//   - Many clients block remote images by default (Apple Mail Privacy
//     Protection, Outlook Protected View). Open counts are an UNDER-
//     count, not a true "did they read it" signal.
//   - Some clients prefetch images on receive (Gmail, Yahoo). Open
//     counts can include "the email server fetched the pixel before
//     the human saw it."
// We log open_count + last_opened_at so the UI can show "first open"
// (real signal) separately if it ever wants to.
import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { ensureEmailSendsTable } from "@/lib/email-tracking";

export const dynamic = "force-dynamic";

// 35-byte transparent 1×1 GIF — smallest valid image we can return.
// Cached at module level so we don't allocate on every request.
const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

export async function GET(_req: Request, { params }: { params: { token: string } }) {
  // Always return the pixel — never fail the response for tracking
  // errors; the recipient's email client should never see anything go
  // wrong here.
  const respond = () =>
    new NextResponse(TRANSPARENT_GIF, {
      status: 200,
      headers: {
        "content-type": "image/gif",
        "content-length": String(TRANSPARENT_GIF.length),
        // Don't let proxies or the client cache the pixel — every open
        // should hit our server fresh so the count is accurate.
        "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
        pragma: "no-cache",
        expires: "0",
      },
    });

  try {
    // Strip an optional ".gif"/".png" suffix on the token so the URL
    // looks like a real image to clients that sniff content type.
    const raw = params.token || "";
    const token = raw.replace(/\.(gif|png|jpg|jpeg)$/i, "");
    if (!/^[a-f0-9]{16,64}$/i.test(token)) return respond();

    await ensureEmailSendsTable();
    await query(
      `UPDATE email_sends
          SET open_count = open_count + 1,
              opened_at = COALESCE(opened_at, NOW()),
              last_opened_at = NOW()
        WHERE tracking_token = $1`,
      [token]
    );
  } catch {
    // Swallow — never break the pixel.
  }
  return respond();
}
