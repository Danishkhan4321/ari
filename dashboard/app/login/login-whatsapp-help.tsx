"use client";

import { useState } from "react";

const DASHBOARD_COMMAND = "open dashboard";

type Props = {
  whatsappUrl: string | null;
};

export function LoginWhatsAppHelp({ whatsappUrl }: Props) {
  const [copied, setCopied] = useState(false);

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(DASHBOARD_COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="space-y-4">
      <ol className="text-sm text-txt-muted space-y-2 list-decimal list-inside">
        <li>Copy the command below (or open WhatsApp with it pre-filled).</li>
        <li>Send it to Ari on WhatsApp from the phone number you use with the bot.</li>
        <li>Tap the login link Ari replies with within 10 minutes.</li>
      </ol>

      <div className="bg-card-lime border-2 border-black rounded-[4px] px-4 py-3 font-mono font-semibold text-lg select-all">
        {DASHBOARD_COMMAND}
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <button
          type="button"
          onClick={copyCommand}
          className="flex-1 dash-btn dash-btn-primary"
        >
          {copied ? "Copied" : "Copy command"}
        </button>
        {whatsappUrl ? (
          <a
            href={whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 dash-btn text-center"
          >
            Open WhatsApp
          </a>
        ) : null}
      </div>

      <p className="text-txt-muted text-xs">
        The green box is the WhatsApp message to send — not a web login button.
        Magic links expire after 10 minutes and work once.
      </p>
    </div>
  );
}
