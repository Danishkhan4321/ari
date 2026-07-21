// dashboard/app/onboarding/page.tsx — post-purchase wizard.
// User lands here from Dodo's return_url after paying. Query params:
//   subscription_id (required) — the Dodo subscription
//   status                     — "succeeded"/"active" expected
//   email                      — Dodo customer email
//
// We verify the subscription via the Dodo API server-side (so a user can't
// fake the URL params), upsert a pending_onboarding row, set a cookie
// carrying the subscription_id (so the Google OAuth round-trip can find
// it), and render the form.
import { redirect } from "next/navigation";
import {
  upsertPending,
  getPending,
  setOnboardingCookie,
  readOnboardingCookie,
} from "@/lib/onboarding";
import { getSubscription } from "@/lib/dodo";
import { tierFromProductId } from "@/lib/products";
import { OnboardingForm } from "./onboarding-form";
import { AriMark } from "@/components/icons";

export const dynamic = "force-dynamic";

type SearchParams = {
  subscription_id?: string;
  status?: string;
  email?: string;
};

export default async function OnboardingPage({ searchParams }: { searchParams: SearchParams }) {
  // Resolve subscription_id from URL (Dodo redirect) OR cookie (came back
  // from Google OAuth round-trip with no query params).
  const subId = searchParams.subscription_id || readOnboardingCookie();

  if (!subId) {
    return <Splash
      title="Where did you come from?"
      body="This page is reached after you complete a Ari purchase. If you just paid, check your email for the receipt link."
      cta={{ label: "Start with Ari", href: "/get-started" }}
    />;
  }

  // Verify the subscription with Dodo. If status isn't active and we just
  // arrived from Dodo's redirect (no cookie yet), bail out. If we already
  // had a pending row (cookie hit) we let it through — they're returning
  // from OAuth and the verification already happened.
  let pending = await getPending(subId);
  if (!pending) {
    const sub = await getSubscription(subId);
    if (!sub) {
      return <Splash
        title="We couldn't find that subscription"
        body="The link looks malformed. If you just paid, refresh from the receipt email — Dodo will resend the link."
        cta={{ label: "Start with Ari", href: "/get-started" }}
      />;
    }
    if (sub.status !== "active" && sub.status !== "pending") {
      return <Splash
        title="That subscription isn't active"
        body={`Status reported by Dodo: ${sub.status}. If you just paid this might be a webhook delay — try refreshing in a minute.`}
        cta={{ label: "Refresh", href: "" }}
      />;
    }
    const tier = sub.product_id ? tierFromProductId(sub.product_id) : null;
    await upsertPending({
      subscription_id: subId,
      product_id: sub.product_id,
      tier: tier ?? undefined,
      dodo_email: sub.customer?.email || searchParams.email,
    });
    pending = await getPending(subId);
  }

  // Set the onboarding cookie so the Google OAuth round-trip can find us
  setOnboardingCookie(subId);

  // If they've already completed, jump straight to the dashboard
  if (pending && pending.status === "completed") {
    redirect("/");
  }

  return (
    <main className="min-h-screen flex items-start justify-center p-6 pt-16">
      <div className="card-brutal rounded-[4px] p-8 max-w-lg w-full">
        <div className="text-5xl mb-4">🎉</div>
        <div className="w-16 h-16 rounded-[16px] bg-ari-midnight grid place-items-center mb-5 shadow-[0_12px_30px_rgba(90,55,214,0.2)]">
          <AriMark className="w-12 h-12" />
        </div>
        <h1 className="text-3xl font-bold mb-2">Welcome to Ari</h1>
        <p className="text-txt-muted mb-6">
          Just three quick things and you&apos;re set.
        </p>

        <OnboardingForm
          subscriptionId={subId}
          existingName={pending?.name ?? ""}
          existingPhone={pending?.phone ?? ""}
          googleEmailConnected={pending?.google_email ?? null}
          dodoEmail={pending?.dodo_email ?? ""}
          tier={pending?.tier ?? "cub"}
        />
      </div>
    </main>
  );
}

function Splash({
  title, body, cta,
}: { title: string; body: string; cta?: { label: string; href: string } }) {
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="card-brutal rounded-[4px] p-8 max-w-md w-full">
        <div className="text-5xl mb-4">🤔</div>
        <h1 className="text-2xl font-bold mb-2">{title}</h1>
        <p className="text-txt-muted mb-6">{body}</p>
        {cta && (
          <a href={cta.href || "javascript:location.reload()"} className="btn-brutal-sm bg-card-lime">{cta.label}</a>
        )}
      </div>
    </main>
  );
}
