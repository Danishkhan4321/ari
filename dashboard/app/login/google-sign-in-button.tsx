"use client";

import { useState } from "react";

type DesktopAuthBridge = {
  startGoogle: () => Promise<{ ok: boolean; error?: string }>;
};

export function GoogleSignInButton() {
  const [message, setMessage] = useState<string | null>(null);

  async function start(event: React.MouseEvent<HTMLAnchorElement>) {
    const bridge = (window as Window & { ariDesktop?: { auth?: DesktopAuthBridge } }).ariDesktop?.auth;
    if (!bridge) return;
    event.preventDefault();
    setMessage("Opening Composio secure sign-in in your browser...");
    const result = await bridge.startGoogle();
    if (!result.ok) setMessage(result.error || "Could not open Composio sign-in.");
  }

  return (
    <>
      <a
        href="/api/auth/google/start"
        onClick={start}
        aria-busy={message ? true : undefined}
        className="flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-[#cfcbc5] bg-white px-5 text-[13px] font-semibold text-[#24211f] shadow-[0_2px_7px_rgba(38,8,5,0.06)] transition hover:border-[#aaa49d] hover:bg-[#fdfcf9] hover:shadow-[0_5px_14px_rgba(38,8,5,0.08)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f7dd2a] active:translate-y-px"
      >
        <ComposioMark />
        Continue with Composio
      </a>
      <p role="status" className="mt-3 min-h-5 text-center text-[11px] text-[#77716c]">
        {message || "Composio manages Google access for Ari"}
      </p>
    </>
  );
}

function ComposioMark() {
  return (
    <span className="grid h-[22px] w-[22px] place-items-center rounded-md bg-[#171717] text-[11px] font-semibold text-[#f7dd2a]" aria-hidden="true">
      C
    </span>
  );
}
