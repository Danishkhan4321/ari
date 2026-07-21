"use client";

// Client-side onboarding form. Three steps shown all on one page:
//   1. Name        — what Ari calls you
//   2. WhatsApp    — phone number where you'll chat with the bot
//   3. Connect Google — kicks off OAuth round-trip (returns to /onboarding)
// On submit of step 1+2, we save partial state to the server so the OAuth
// round-trip in step 3 can pick up where we left off.
import { useState } from "react";

type Props = {
  subscriptionId: string;
  existingName: string;
  existingPhone: string;
  googleEmailConnected: string | null;
  dodoEmail: string;
  tier: string;
};

export function OnboardingForm({
  subscriptionId, existingName, existingPhone, googleEmailConnected, dodoEmail, tier,
}: Props) {
  const [name, setName] = useState(existingName);
  const [phone, setPhone] = useState(existingPhone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedProfile, setSavedProfile] = useState(Boolean(existingName && existingPhone));
  const googleConnected = Boolean(googleEmailConnected);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim() || !phone.trim()) {
      setError("Name and WhatsApp number are required.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/onboarding/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription_id: subscriptionId, name, phone }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error || "Could not save. Try again.");
      } else {
        setSavedProfile(true);
      }
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function complete() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription_id: subscriptionId }),
      });
      if (res.redirected) {
        window.location.href = res.url;
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { error?: string; redirect?: string };
      if (data.redirect) { window.location.href = data.redirect; return; }
      if (!res.ok) setError(data.error || "Could not finalize.");
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-card-lime/40 border-2 border-black rounded-[4px] px-4 py-3 text-sm">
        <span className="font-semibold">Plan:</span> {tier.charAt(0).toUpperCase() + tier.slice(1)}
        {dodoEmail && <span className="ml-2 text-txt-muted">· Receipt sent to {dodoEmail}</span>}
      </div>

      <form onSubmit={saveProfile} className="space-y-4">
        <Step n={1} done={savedProfile} title="What should Ari call you?">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="First name"
            maxLength={60}
            required
            className="input-brutal"
            disabled={savedProfile && !error}
          />
        </Step>

        <Step n={2} done={savedProfile} title="Your WhatsApp number">
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+91 98765 43210"
            required
            className="input-brutal"
            disabled={savedProfile && !error}
          />
          <p className="text-xs text-txt-muted mt-1">Include country code. This is where you&apos;ll chat with Ari.</p>
        </Step>

        {!savedProfile && (
          <button type="submit" disabled={busy} className="btn-brutal-sm bg-card-lime w-full disabled:opacity-50">
            {busy ? "Saving..." : "Save and continue"}
          </button>
        )}
      </form>

      <Step n={3} done={googleConnected} title="Connect your Google account">
        {googleConnected ? (
          <div className="bg-card-lime/40 border-2 border-black rounded-[4px] px-4 py-2 text-sm font-semibold">
            ✓ Connected as {googleEmailConnected}
          </div>
        ) : (
          <>
            <p className="text-xs text-txt-muted mb-3">
              Lets Ari read and send email on your behalf. You can revoke anytime in Google account settings.
            </p>
            <a
              href={savedProfile ? "/api/auth/google/start?flow=onboarding" : undefined}
              aria-disabled={!savedProfile}
              onClick={(e) => { if (!savedProfile) e.preventDefault(); }}
              className={`flex items-center justify-center gap-3 w-full bg-white text-black border-2 border-black rounded-[4px] px-5 py-3 font-semibold shadow-brutal transition-all duration-150 ${
                savedProfile
                  ? "hover:shadow-brutal-hover hover:translate-x-[2px] hover:translate-y-[2px] active:shadow-none active:translate-x-1 active:translate-y-1"
                  : "opacity-50 cursor-not-allowed"
              }`}
            >
              <GoogleG />
              Connect with Google
            </a>
          </>
        )}
      </Step>

      {error && (
        <div className="bg-card-orange/30 border-2 border-black rounded-[4px] px-4 py-3 text-sm">
          ⚠️ {error}
        </div>
      )}

      {savedProfile && googleConnected && (
        <button onClick={complete} disabled={busy} className="btn-brutal w-full disabled:opacity-50">
          {busy ? "Setting up..." : "Open my dashboard →"}
        </button>
      )}
    </div>
  );
}

function Step({ n, done, title, children }: {
  n: number; done: boolean; title: string; children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <span className={`inline-flex items-center justify-center w-7 h-7 border-2 border-black rounded-full font-bold text-sm ${
          done ? "bg-card-lemon" : "bg-card"
        }`}>{done ? "✓" : n}</span>
        <span className="font-semibold">{title}</span>
      </div>
      <div className="ml-9">{children}</div>
    </div>
  );
}

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
