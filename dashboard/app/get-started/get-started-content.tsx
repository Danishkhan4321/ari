"use client";

import { useState } from "react";

type Props = {
  phoneDisplay: string;
  phoneDigits: string;
  startUrl: string;
  dashboardUrl: string;
};

const TRY_COMMANDS = [
  { label: "Say hello", text: "hi" },
  { label: "Set a reminder", text: "remind me tomorrow at 9am to test Ari" },
];

export function GetStartedContent({
  phoneDisplay,
  phoneDigits,
  startUrl,
  dashboardUrl,
}: Props) {
  const [copied, setCopied] = useState<"phone" | string | null>(null);

  async function copyText(value: string, key: "phone" | string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wider">Step 1 — Message Ari on WhatsApp</h2>
        <p className="text-sm text-txt-muted">
          Save this number, or tap Open WhatsApp. Send <span className="font-mono font-semibold">hi</span> from the phone you want to use with Ari.
        </p>

        <div className="bg-card-lime border-2 border-black rounded-[4px] px-4 py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-txt-muted mb-1">Ari WhatsApp</div>
            <div className="text-2xl font-bold font-mono">{phoneDisplay}</div>
          </div>
          <div className="flex flex-col sm:flex-row gap-2 shrink-0">
            <button
              type="button"
              onClick={() => copyText(phoneDigits, "phone")}
              className="dash-btn"
            >
              {copied === "phone" ? "Copied" : "Copy number"}
            </button>
            <a href={startUrl} target="_blank" rel="noopener noreferrer" className="dash-btn dash-btn-primary text-center">
              Open WhatsApp
            </a>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wider">Step 2 — Try a command</h2>
        <p className="text-sm text-txt-muted">
          After Ari replies, try any of these. Tap copy, paste into WhatsApp, and send.
        </p>
        <div className="space-y-2">
          {TRY_COMMANDS.map((cmd) => (
            <div
              key={cmd.text}
              className="border-2 border-black rounded-[4px] px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 bg-white"
            >
              <div>
                <div className="text-xs font-semibold text-txt-muted">{cmd.label}</div>
                <div className="font-mono text-sm font-semibold">{cmd.text}</div>
              </div>
              <button
                type="button"
                onClick={() => copyText(cmd.text, cmd.text)}
                className="dash-btn sm:shrink-0"
              >
                {copied === cmd.text ? "Copied" : "Copy"}
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wider">Step 3 — Sign in to your workspace</h2>
        <p className="text-sm text-txt-muted">
          Open the dashboard and continue with Google. Ari verifies your account, then Composio securely connects the Google apps you authorize.
        </p>
        <a href={dashboardUrl} className="dash-btn dash-btn-primary inline-block text-center">
          Go to dashboard login →
        </a>
      </section>
    </div>
  );
}
