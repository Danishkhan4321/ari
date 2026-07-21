"use client";

import { useEffect, useState } from "react";
import { AriMark } from "@/components/icons";

export default function DesktopAuthReturn() {
  const [deepLink, setDeepLink] = useState<string | null>(null);

  useEffect(() => {
    const ticket = new URLSearchParams(window.location.hash.slice(1)).get("ticket");
    if (!ticket || !/^[a-f0-9]{64}$/i.test(ticket)) return;
    const target = `ari://auth/callback?ticket=${encodeURIComponent(ticket)}`;
    setDeepLink(target);
    window.location.replace(target);
  }, []);

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="card-brutal rounded-[4px] p-8 max-w-md w-full text-center">
        <div className="mx-auto w-14 h-14 rounded-[14px] bg-ari-midnight grid place-items-center mb-5">
          <AriMark className="w-10 h-10" />
        </div>
        <h1 className="text-2xl font-bold mb-2">Google sign-in complete</h1>
        <p className="text-txt-muted mb-5">Return to Ari to continue. You can close this browser tab.</p>
        {deepLink ? <a className="dash-btn dash-btn-primary" href={deepLink}>Open Ari</a> : (
          <p className="text-sm text-card-orange">This sign-in link is missing or expired. Start again from Ari.</p>
        )}
      </div>
    </main>
  );
}
