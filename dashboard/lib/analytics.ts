// dashboard/lib/analytics.ts
//
// Lightweight client-side event tracking. Wraps PostHog if a key is
// configured; falls back to a no-op in dev so we don't pollute analytics
// during development.
//
// Why this instead of vendor-direct calls scattered across the app:
//   1. Single named-event vocabulary — autocomplete + grep works
//   2. Easy to swap providers (Mixpanel, Amplitude, self-hosted)
//   3. Can stub in tests
//
// Activation events to track (the ones we care about):
//   - team_tab_opened
//   - signup_completed
//   - first_standup_submitted   (server-side, fired from bot)
//   - first_broadcast_sent      (fired when admin sends first broadcast)
//   - first_kudos_given         (fired when first kudos sent)
//   - team_created              (fired when admin creates first team)
//   - bulk_invite_completed     (fired with member count)

let _posthog: PostHogLike | null = null;
let _initAttempted = false;

interface PostHogLike {
  capture(event: string, props?: Record<string, unknown>): void;
  identify(distinctId: string, props?: Record<string, unknown>): void;
  reset(): void;
}

async function getPosthog(): Promise<PostHogLike | null> {
  if (typeof window === "undefined") return null;
  if (_posthog) return _posthog;
  if (_initAttempted) return null;
  _initAttempted = true;

  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return null; // no key configured → silent no-op
  try {
    // Dynamic import so the SDK never lands in the bundle when no key set.
    const ph = (await import("posthog-js")).default;
    ph.init(key, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
      person_profiles: "identified_only",
      capture_pageview: false,            // we'll fire team_tab_opened manually
      capture_pageleave: true,
      autocapture: false,                 // explicit > implicit for B2B SaaS
      disable_session_recording: true,    // privacy: no session replay by default
    });
    _posthog = ph as unknown as PostHogLike;
    return _posthog;
  } catch {
    return null;
  }
}

export async function track(event: string, props: Record<string, unknown> = {}): Promise<void> {
  const ph = await getPosthog();
  ph?.capture(event, { ...props, ts: new Date().toISOString() });
}

export async function identify(userPhone: string, props: Record<string, unknown> = {}): Promise<void> {
  const ph = await getPosthog();
  // Hash the phone before sending — PII shouldn't land in analytics raw.
  // Simple hash — not cryptographic, just an opaque stable id.
  const id = userPhone ? `u_${simpleHash(userPhone)}` : "anonymous";
  ph?.identify(id, props);
}

export async function reset(): Promise<void> {
  const ph = await getPosthog();
  ph?.reset();
}

// Synchronous wrappers — fire-and-forget. If PostHog isn't initialized
// yet the event is dropped, which is fine for activation funnels: the
// first events that matter (team_created, first_broadcast_sent) all
// happen after the user has already loaded the page, so PostHog is up.
export function trackSync(event: string, props: Record<string, unknown> = {}): void {
  void track(event, props);
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).slice(0, 12);
}
