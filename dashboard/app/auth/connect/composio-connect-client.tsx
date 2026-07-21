"use client";

import { useCallback, useEffect, useState } from "react";
import { AriMark } from "@/components/icons";

export function ComposioConnectClient({ desktop }: { desktop: boolean }) {
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/settings/google", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ product: "all", destination: desktop ? "desktop" : "dashboard" }),
      });
      const data = await response.json().catch(() => ({})) as { ok?: boolean; url?: string; error?: string };
      if (!response.ok || data.ok !== true || !data.url) {
        throw new Error(data.error || "Composio could not start the secure connection.");
      }
      window.location.replace(data.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Composio could not start the secure connection.");
    }
  }, [desktop]);

  useEffect(() => { void connect(); }, [connect]);

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#f3f2ed] px-5 py-10">
      <div className="pointer-events-none absolute -left-28 -top-28 h-80 w-80 rounded-full bg-[#f7dd2a]/35 blur-3xl" />
      <section className="relative w-full max-w-[460px] rounded-[24px] border border-[#d9d7d2] bg-white p-8 text-center shadow-[0_24px_70px_rgba(38,8,5,0.09)] sm:p-10">
        <AriMark className="mx-auto h-12 w-12" />
        <div className="mx-auto mt-8 flex h-10 w-10 items-center justify-center rounded-full bg-[#fff8c7]" aria-hidden="true">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#b5a31d] border-t-transparent motion-reduce:animate-none" />
        </div>
        <p className="mt-6 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8a837d]">Secure connection</p>
        <h1 className="mt-2 text-[25px] font-semibold tracking-[-0.035em] text-[#171717]">Connecting your workspace</h1>
        <p className="mx-auto mt-3 max-w-sm text-[14px] leading-6 text-[#706965]">
          Composio will securely connect the Google apps Ari uses on your behalf. Your credentials are never exposed to Ari.
        </p>
        <div className="mt-7 flex items-center justify-center gap-2 text-[12px] text-[#706965]">
          <GoogleMiniMark />
          <span>Google</span><span aria-hidden="true">→</span><span className="font-medium text-[#24211f]">Composio</span><span aria-hidden="true">→</span><span>Ari</span>
        </div>
        {error ? (
          <div role="alert" className="mt-7 rounded-xl border border-[#ead0cc] bg-[#fff8f6] p-4 text-left">
            <p className="text-[12px] font-medium text-[#9f2f25]">Connection paused</p>
            <p className="mt-1 text-[12px] leading-5 text-[#706965]">{error}</p>
            <button type="button" onClick={() => void connect()} className="mt-4 inline-flex h-9 items-center rounded-lg bg-[#171717] px-4 text-[12px] font-medium text-white hover:bg-[#2b2926] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f7dd2a]">
              Try again
            </button>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function GoogleMiniMark() {
  return <span className="grid h-6 w-6 place-items-center rounded-full border border-[#e4e1dc] bg-white text-[11px] font-semibold text-[#4285f4]">G</span>;
}
