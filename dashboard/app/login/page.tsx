// dashboard/app/login/page.tsx — sign-in.
// Two paths:
//   1. "Continue with Google" — works for users who already connected
//      their Google account through the bot. Looks up user_phone by
//      google_email. Most existing customers will have this.
//   2. WhatsApp magic-link — fallback / users without Google connected.
//      Send Ari "open dashboard" → tap the DM'd link.
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUserPhone } from "@/lib/session";
import { AriMark } from "@/components/icons";
import { whatsappDeepLink } from "@/lib/whatsapp";
import { LoginWhatsAppHelp } from "./login-whatsapp-help";

type SearchParams = { error?: string };

export default async function Login({ searchParams }: { searchParams: SearchParams }) {
  if (await getCurrentUserPhone()) redirect("/");

  const error = searchParams.error;
  const errorMsg = error ? friendlyError(error) : null;
  // "not_connected" gets a richer message with a Buy CTA — the user
  // signed in fine, but their email isn't a paying Ari customer yet.
  const showBuyCta = error === "not_connected";
  const googleConfigured = Boolean(process.env.GOOGLE_CLIENT_ID);
  const whatsappUrl = whatsappDeepLink("open dashboard") || null;

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="card-brutal rounded-[4px] p-8 max-w-md w-full">
        <div className="w-16 h-16 rounded-[16px] bg-ari-midnight grid place-items-center mb-5 shadow-[0_12px_30px_rgba(90,55,214,0.2)]">
          <AriMark className="w-12 h-12" />
        </div>
        <h1 className="text-3xl font-bold mb-2">Sign in to Ari</h1>
        <p className="text-txt-muted mb-6">
          {googleConfigured
            ? "Pick whichever is faster. Both end up signed in to the same account."
            : "Sign in with the WhatsApp magic link from the same phone you use with Ari."}
        </p>

        {errorMsg && (
          <div className={`border-2 border-black rounded-[4px] px-4 py-3 mb-6 text-sm ${showBuyCta ? "bg-card-lime" : "bg-card-orange/30"}`}>
            <div className="font-semibold mb-1">{showBuyCta ? "Looks like you don't have Ari yet" : "Couldn't sign you in"}</div>
            <div className="mb-3">{errorMsg}</div>
            {showBuyCta && (
              <a
                href="/get-started"
                className="dash-btn dash-btn-primary"
              >
                Get Ari →
              </a>
            )}
          </div>
        )}

        {googleConfigured && (
          <a
            href="/api/auth/google/start"
            className="flex items-center justify-center gap-3 w-full bg-white text-black border-2 border-black rounded-[4px] px-5 py-3 font-semibold shadow-brutal hover:shadow-brutal-hover hover:translate-x-[2px] hover:translate-y-[2px] active:shadow-none active:translate-x-1 active:translate-y-1 transition-all duration-150 mb-4"
          >
            <GoogleG />
            Continue with Google
          </a>
        )}

        {googleConfigured ? (
          <div className="my-5 flex items-center gap-3">
            <div className="flex-1 h-[2px] bg-black/10" />
            <span className="text-xs text-txt-muted font-semibold tracking-wider uppercase">or</span>
            <div className="flex-1 h-[2px] bg-black/10" />
          </div>
        ) : null}

        <h2 className="text-sm font-bold uppercase tracking-wider mb-3">WhatsApp magic link</h2>
        <LoginWhatsAppHelp whatsappUrl={whatsappUrl} />

        <p className="text-txt-muted text-sm mt-6">
          New to Ari?{" "}
          <Link href="/get-started" className="font-semibold underline">
            Get started with the WhatsApp number →
          </Link>
        </p>

        <p className="text-txt-muted text-sm mt-6">
          Don&apos;t have Ari yet?{" "}
          <Link href="/get-started" className="font-semibold underline text-ari-violet-700">
            Ari setup →
          </Link>
        </p>
      </div>
    </main>
  );
}

function friendlyError(code: string): string {
  switch (code) {
    case "not_connected":
      return "Your Google account isn't registered with Ari. To use the dashboard, buy Ari first — once you're set up, this Google account will be linked automatically and sign-in will just work.";
    case "google_denied":
      return "You cancelled the Google sign-in.";
    case "email_unverified":
      return "That Google account doesn't have a verified email. Verify it in your Google settings and try again.";
    case "state_mismatch":
      return "Sign-in attempt expired or got mixed up. Try again.";
    case "google_error":
    case "google_exchange_failed":
      return "Google didn't return a valid sign-in. Try again.";
    case "not_configured":
      return "Google sign-in isn't set up on this server yet.";
    case "invalid_callback":
      return "Sign-in callback was malformed. Try again.";
    default:
      return "Something went wrong. Try again.";
  }
}

// Plain inline G logo — same colors Google uses, sized to match the
// neo-brutal button. Avoids dragging in an icon library.
function GoogleG() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" fill="#34A853"/>
      <path d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" fill="#EA4335"/>
    </svg>
  );
}
