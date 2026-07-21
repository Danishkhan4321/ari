"use client";

// Home hero — greeting + live local clock pill. Ported from
// Ari's preview dashboard. Pulls the user's name from /api/me
// (Google email-derived) so the greeting feels personal instead of
// "+918420982366".
import { useEffect, useState } from "react";

type Me = { name: string; email: string | null };

export function HomeHero() {
  const [me, setMe] = useState<Me | null>(null);
  const { time, date } = useLocalClock();

  useEffect(() => {
    fetch("/api/me", { cache: "no-store" })
      .then(r => r.json())
      .then((d: { ok: boolean; name?: string; email?: string | null }) => {
        if (d?.ok) setMe({ name: d.name || "", email: d.email || null });
      })
      .catch(() => {});
  }, []);

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 17) return "Good afternoon";
    return "Good evening";
  })();

  // Use just the first word of the name for the greeting; fall back to
  // empty string while loading so the heading doesn't flicker.
  const firstName = (me?.name || "").split(/\s+/)[0] || "";

  return (
    <div className="flex items-end justify-between flex-wrap gap-6 mb-12">
      <div>
        <div className="dash-label mb-3">Today · {date || "—"}</div>
        <h1 className="dash-h1 text-[28px]">
          {greeting}{firstName ? `, ${firstName}` : ""}
        </h1>
        {me?.email && (
          <p className="text-[13.5px] text-[#737373] mt-2.5 leading-relaxed">
            Signed in as <span className="text-[#0a0a0a] font-medium">{me.email}</span>.
          </p>
        )}
      </div>
      <div
        className="px-4 py-2 flex items-center gap-3 bg-[#D8CCFF] border border-[#0a0a0a]"
        style={{ borderRadius: 8, boxShadow: "3px 3px 0 #0a0a0a" }}
      >
        <span className="text-[12.5px] font-semibold num">{time || "—"}</span>
        <span className="w-px h-3 bg-[#0a0a0a]/30" />
        <span className="flex items-center gap-1.5 text-[11px] font-medium">
          <span className="w-1.5 h-1.5 rounded-full bg-[#3FAA6E]" />
          Synced
        </span>
      </div>
    </div>
  );
}

function useLocalClock() {
  const [time, setTime] = useState("");
  const [date, setDate] = useState("");
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const hh = d.getHours();
      const mm = String(d.getMinutes()).padStart(2, "0");
      setTime(`${hh % 12 || 12}:${mm} ${hh >= 12 ? "PM" : "AM"}`);
      setDate(
        d.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" })
      );
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);
  return { time, date };
}
