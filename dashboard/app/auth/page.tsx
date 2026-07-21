// dashboard/app/auth/page.tsx — magic-link consumer.
// The bot DMs URLs of the form  https://<host>/auth?code=ABC123
// On hit we POST the code to /api/auth/claim, which marks the code used in
// `link_codes`, creates a `dashboard_sessions` row, and sets the cookie.
"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AriMark } from "@/components/icons";

export default function AuthPage() {
  // Next 14 requires useSearchParams to live inside a Suspense boundary so
  // the page can be statically pre-rendered. The actual claim runs on the
  // client anyway.
  return (
    <Suspense fallback={<AuthShell title="Signing you in…" body="Verifying your link with Ari." emoji="🔐" />}>
      <AuthInner />
    </Suspense>
  );
}

function AuthInner() {
  const router = useRouter();
  const params = useSearchParams();
  const code = params.get("code");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!code) {
      setError("No code in this link. Ask Ari for a fresh one.");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code }),
        });
        if (cancelled) return;
        if (res.ok) {
          router.replace("/");
          return;
        }
        const data = (await res.json().catch(() => ({}))) as { reason?: string };
        setError(friendlyError(data.reason));
      } catch {
        if (!cancelled) setError("Something went wrong. Please try again.");
      }
    })();
    return () => { cancelled = true; };
  }, [code, router]);

  if (error) {
    return (
      <AuthShell title="Couldn't sign you in" body={error} emoji="⚠️">
        <a href="/login" className="btn-brutal-sm bg-card-lime mt-2">Back to login</a>
      </AuthShell>
    );
  }
  return <AuthShell title="Signing you in…" body="Verifying your link with Ari." emoji="🔐" />;
}

function AuthShell({
  title, body, emoji, children,
}: { title: string; body: string; emoji: string; children?: React.ReactNode }) {
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="card-brutal rounded-[4px] p-8 max-w-md w-full">
        <div className="w-14 h-14 rounded-[14px] bg-ari-midnight grid place-items-center mb-5">
          <AriMark className="w-10 h-10" />
        </div>
        <div className="text-5xl mb-4">{emoji}</div>
        <h1 className="text-2xl font-bold mb-2">{title}</h1>
        <p className="text-txt-muted mb-2">{body}</p>
        {children}
      </div>
    </main>
  );
}

function friendlyError(reason: string | undefined): string {
  switch (reason) {
    case "expired": return "This link expired. Send Ari 'open dashboard' on WhatsApp for a fresh one.";
    case "used":    return "This link was already used. Ask Ari for a new one.";
    case "invalid": return "This link looks wrong. Make sure you tapped it from Ari's last message.";
    default:        return "Something went wrong on our side. Please try again.";
  }
}
