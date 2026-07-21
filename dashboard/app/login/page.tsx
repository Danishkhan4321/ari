import { redirect } from "next/navigation";
import { AriMark } from "@/components/icons";
import { getCurrentUserPhone } from "@/lib/session";
import { GoogleSignInButton } from "./google-sign-in-button";

type SearchParams = { error?: string };

const benefits = [
  "One secure identity across Ari",
  "Google apps connected through Composio",
  "Your session stays signed in on this device",
];

export default async function Login({ searchParams }: { searchParams: SearchParams }) {
  if (await getCurrentUserPhone()) redirect("/");

  const errorMsg = searchParams.error ? friendlyError(searchParams.error) : null;
  const googleConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#f2f1ec] px-4 py-6 sm:px-8 sm:py-10">
      <div className="pointer-events-none absolute -left-36 -top-40 h-[420px] w-[420px] rounded-full bg-[#f7dd2a]/35 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-52 -right-40 h-[460px] w-[460px] rounded-full bg-[#eee4fa]/70 blur-3xl" />

      <section className="relative grid w-full max-w-[1060px] overflow-hidden rounded-[28px] border border-[#d8d5cf] bg-white shadow-[0_28px_90px_rgba(38,8,5,0.11)] lg:grid-cols-[1.04fr_0.96fr]">
        <div className="relative hidden min-h-[610px] flex-col overflow-hidden bg-[#191814] p-12 text-white lg:flex">
          <div className="absolute -right-32 -top-28 h-80 w-80 rounded-full bg-[#f7dd2a]/20 blur-3xl" />
          <div className="absolute bottom-[-90px] left-[-80px] h-72 w-72 rounded-full border border-white/10" />
          <div className="relative flex items-center gap-3">
            <AriMark className="h-11 w-11" />
            <span className="text-[15px] font-semibold tracking-[-0.02em]">Ari</span>
          </div>

          <div className="relative my-auto max-w-[430px] py-14">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#d8c326]">Your AI workspace</p>
            <h1 className="mt-5 text-[44px] font-semibold leading-[1.08] tracking-[-0.05em]">
              Work moves faster when it lives together.
            </h1>
            <p className="mt-5 max-w-[390px] text-[15px] leading-7 text-white/65">
              Bring conversations, meetings, contacts, and daily execution into one focused workspace with Ari.
            </p>

            <ul className="mt-9 space-y-4" aria-label="Sign-in benefits">
              {benefits.map((benefit) => (
                <li key={benefit} className="flex items-center gap-3 text-[13px] text-white/85">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[#f7dd2a] text-[#191814]" aria-hidden="true">
                    <CheckIcon />
                  </span>
                  {benefit}
                </li>
              ))}
            </ul>
          </div>

          <p className="relative text-[11px] leading-5 text-white/45">Private by design. Access stays scoped to your account.</p>
        </div>

        <div className="flex min-h-[610px] items-center px-7 py-10 sm:px-12 lg:px-14">
          <div className="mx-auto w-full max-w-[390px]">
            <div className="mb-10 flex items-center gap-3 lg:hidden">
              <AriMark className="h-10 w-10" />
              <span className="text-[15px] font-semibold">Ari</span>
            </div>

            <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-[#8a837d]">Welcome to Ari</p>
            <h2 className="mt-3 text-[32px] font-semibold leading-tight tracking-[-0.045em] text-[#171717]">Sign in to your workspace</h2>
            <p className="mt-3 text-[14px] leading-6 text-[#706965]">
              Continue with Google. Ari verifies your identity, then Composio securely connects the Google tools you choose.
            </p>

            {errorMsg ? (
              <div role="alert" className="mt-6 rounded-xl border border-[#ead0cc] bg-[#fff8f6] px-4 py-3.5">
                <p className="text-[12px] font-semibold text-[#9f2f25]">Couldn&apos;t sign you in</p>
                <p className="mt-1 text-[12px] leading-5 text-[#706965]">{errorMsg}</p>
              </div>
            ) : null}

            <div className="mt-8">
              {googleConfigured ? (
                <GoogleSignInButton />
              ) : (
                <div className="rounded-xl border border-[#ead0cc] bg-[#fff8f6] p-4 text-[12px] leading-5 text-[#8f342b]">
                  Google sign-in is temporarily unavailable. Ask the Ari administrator to finish authentication setup.
                </div>
              )}
            </div>

            <div className="mt-7 rounded-xl border border-[#e5e2dc] bg-[#faf9f6] p-4">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white text-[#4d4945] shadow-[0_1px_3px_rgba(38,8,5,0.08)]"><ShieldIcon /></span>
                <div>
                  <p className="text-[12px] font-medium text-[#24211f]">Secure account connection</p>
                  <p className="mt-1 text-[11px] leading-5 text-[#77716c]">Google verifies who you are. Composio manages app permissions and token refresh without exposing credentials to Ari.</p>
                </div>
              </div>
            </div>

            <p className="mt-8 text-center text-[10.5px] leading-5 text-[#948d87]">
              By continuing, you agree to use Ari responsibly and only connect accounts you control.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}

function CheckIcon() {
  return <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="m3.5 8 2.7 2.7 6.3-6.2" /></svg>;
}

function ShieldIcon() {
  return <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M10 2.5 16 5v4.4c0 3.8-2.4 6.5-6 8.1-3.6-1.6-6-4.3-6-8.1V5l6-2.5Z" /><path d="m7.2 9.8 1.8 1.8 3.9-4" /></svg>;
}

function friendlyError(code: string): string {
  switch (code) {
    case "not_connected": return "That Google account could not be registered. Try again.";
    case "google_denied": return "You cancelled Google sign-in.";
    case "email_unverified": return "That Google account does not have a verified email.";
    case "state_mismatch": return "This sign-in attempt expired. Please try again.";
    case "google_error":
    case "google_exchange_failed": return "Google did not return a valid sign-in. Please try again.";
    case "not_configured": return "Google sign-in is not configured on this server yet.";
    case "invalid_callback": return "The sign-in callback was incomplete. Please try again.";
    default: return "Something went wrong. Please try again.";
  }
}
