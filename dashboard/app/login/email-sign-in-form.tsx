"use client";

import { useState } from "react";

export function EmailSignInForm() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, name }),
      });
      const data = await response.json().catch(() => ({})) as { ok?: boolean; redirect?: string; error?: string };
      if (!response.ok || data.ok !== true) {
        throw new Error(data.error || "Could not sign you in.");
      }
      window.location.assign(data.redirect || "/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign you in.");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block">
        <span className="text-[12px] font-medium text-[#4d4945]">Email</span>
        <input
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          className="mt-1.5 h-12 w-full rounded-xl border border-[#d6d2cc] bg-white px-4 text-[14px] text-[#171717] outline-none transition placeholder:text-[#a59f99] focus:border-[#171717] focus:ring-2 focus:ring-[#f7dd2a]/55"
        />
      </label>

      <label className="block">
        <span className="text-[12px] font-medium text-[#4d4945]">Name <span className="font-normal text-[#948d87]">(optional)</span></span>
        <input
          type="text"
          autoComplete="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Danish Khan"
          className="mt-1.5 h-12 w-full rounded-xl border border-[#d6d2cc] bg-white px-4 text-[14px] text-[#171717] outline-none transition placeholder:text-[#a59f99] focus:border-[#171717] focus:ring-2 focus:ring-[#f7dd2a]/55"
        />
      </label>

      <button
        type="submit"
        disabled={loading}
        className="flex h-12 w-full items-center justify-center rounded-xl bg-[#171717] px-5 text-[13px] font-semibold text-white shadow-[0_8px_22px_rgba(23,23,23,0.15)] transition hover:bg-[#2b2926] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f7dd2a] disabled:cursor-not-allowed disabled:opacity-65"
      >
        {loading ? "Opening Ari..." : "Continue to Ari"}
      </button>

      {error ? (
        <p role="alert" className="rounded-lg border border-[#ead0cc] bg-[#fff8f6] px-3 py-2 text-[12px] leading-5 text-[#9f2f25]">
          {error}
        </p>
      ) : null}
    </form>
  );
}
