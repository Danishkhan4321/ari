// dashboard/app/login/page.tsx — sign-in.
// Two paths:
//   1. "Continue with Google" — registers any verified Google account and
//      reuses the existing Ari identity when that email was linked before.
//   2. WhatsApp magic-link — fallback / users without Google connected.
//      Send Ari "open dashboard" → tap the DM'd link.
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUserPhone } from "@/lib/session";
import { AriMark } from "@/components/icons";
import { whatsappDeepLink } from "@/lib/whatsapp";
import { LoginWhatsAppHelp } from "./login-whatsapp-help";
import { GoogleSignInButton } from "./google-sign-in-button";

type SearchParams = { error?: string };

export default async function Login({ searchParams }: { searchParams: SearchParams }) {
  if (await getCurrentUserPhone()) redirect("/");

  const error = searchParams.error;
  const errorMsg = error ? friendlyError(error) : null;
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
          <div className="border-2 border-black rounded-[4px] bg-card-orange/30 px-4 py-3 mb-6 text-sm">
            <div className="font-semibold mb-1">Couldn&apos;t sign you in</div>
            <div>{errorMsg}</div>
          </div>
        )}

        {googleConfigured && <GoogleSignInButton />}

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
      return "That Google account could not be registered. Try again.";
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
