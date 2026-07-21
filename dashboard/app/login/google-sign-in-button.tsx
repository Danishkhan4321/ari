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
    setMessage("Opening Google in your browser…");
    const result = await bridge.startGoogle();
    if (!result.ok) setMessage(result.error || "Could not open Google sign-in.");
  }

  return (
    <>
      <a
        href="/api/auth/google/start"
        onClick={start}
        className="flex items-center justify-center gap-3 w-full bg-white text-black border-2 border-black rounded-[4px] px-5 py-3 font-semibold shadow-brutal hover:shadow-brutal-hover hover:translate-x-[2px] hover:translate-y-[2px] active:shadow-none active:translate-x-1 active:translate-y-1 transition-all duration-150 mb-2"
      >
        <GoogleG />
        Continue with Google
      </a>
      {message ? <p role="status" className="mb-4 text-center text-sm text-txt-muted">{message}</p> : <div className="mb-2" />}
    </>
  );
}

function GoogleG() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" fill="#34A853" />
      <path d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" fill="#EA4335" />
    </svg>
  );
}
