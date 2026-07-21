"use client";

// Cmd+K command palette. Lightweight: filters a static list of
// destinations + actions by substring. No external deps. Renders into a
// portal-less modal because Next.js + RSC are fine without one for this.
//
// Open: ⌘K (mac) / Ctrl+K (others) / sidebar button.
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Item = {
  label: string;
  hint?: string;
  href?: string;
  action?: () => void;
  group: "Navigate" | "Actions";
  keywords?: string[];
};

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset when reopened
  useEffect(() => {
    if (open) { setQ(""); setCursor(0); setTimeout(() => inputRef.current?.focus(), 10); }
  }, [open]);

  // Global ⌘K / Ctrl+K listener (lives here so the wrapper Shell can
  // delegate keyboard handling).
  // ESC closes
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const items: Item[] = useMemo(() => [
    { label: "Home",                href: "/",                  group: "Navigate", keywords: ["dashboard", "kpi"] },
    { label: "Home",              href: "/chat",              group: "Navigate", keywords: ["chat", "message", "ari"] },
    { label: "Reminders",           href: "/reminders",         group: "Navigate", keywords: ["alarm", "alert"] },
    { label: "Tasks",               href: "/tasks",             group: "Navigate", keywords: ["todo", "to-do"] },
    { label: "Contacts & CRM",      href: "/contacts",          group: "Navigate", keywords: ["people", "crm", "leads"] },
    { label: "Pipeline",            href: "/contacts/pipeline", group: "Navigate", keywords: ["kanban", "deals", "sales"] },
    { label: "Groups",              href: "/contacts/groups",   group: "Navigate", keywords: ["segments", "lists", "bulk"] },
    { label: "Campaigns",           href: "/contacts/campaigns",group: "Navigate", keywords: ["bulk email", "blast", "history"] },
    { label: "Inbox",               href: "/inbox",             group: "Navigate", keywords: ["scheduled", "email"] },
    { label: "Meetings",            href: "/meetings",          group: "Navigate", keywords: ["recording", "transcript"] },
    { label: "Flowtype history", href: "/transcriptions", group: "Navigate", keywords: ["voice", "dictation", "transcription", "history", "copy"] },
    { label: "Team",                href: "/team",              group: "Navigate", keywords: ["standups", "polls", "leave"] },
    { label: "Settings",            href: "/settings",          group: "Navigate", keywords: ["account", "integrations", "AI"] },
    { label: "Sign out",            action: () => { document.location.href = "/api/auth/logout"; }, group: "Actions" },
  ], []);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return items;
    return items.filter(it => {
      const hay = [it.label, ...(it.keywords || [])].join(" ").toLowerCase();
      return hay.includes(term);
    });
  }, [items, q]);

  const grouped = useMemo(() => {
    const out: Record<string, Item[]> = {};
    for (const it of filtered) (out[it.group] ||= []).push(it);
    return out;
  }, [filtered]);

  // Track index across the flat list (filtered) for arrow nav
  useEffect(() => { setCursor(0); }, [q]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(filtered.length - 1, c + 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
      else if (e.key === "Enter") {
        e.preventDefault();
        const sel = filtered[cursor];
        if (!sel) return;
        if (sel.href) { router.push(sel.href); onClose(); }
        else if (sel.action) { sel.action(); onClose(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, filtered, cursor, router, onClose]);

  if (!open) return null;
  let runningIdx = -1;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-24 px-4 bg-black/40" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl bg-white border border-ari-border-strong rounded-[12px] shadow-[0_24px_70px_rgba(49,31,85,0.22)] overflow-hidden"
      >
        <div className="border-b border-ari-border px-4 py-3 flex items-center gap-3">
          <span className="text-xl">🔍</span>
          <input
            ref={inputRef}
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Type to search…"
            className="flex-1 outline-none text-base font-medium bg-transparent"
          />
          <kbd className="px-1.5 py-0.5 border border-black/30 rounded text-[10px] font-mono">ESC</kbd>
        </div>
        <div className="max-h-[50vh] overflow-y-auto py-2">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-center text-txt-muted text-sm">No matches.</div>
          )}
          {Object.entries(grouped).map(([groupName, groupItems]) => (
            <div key={groupName}>
              <div className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-wider font-bold text-txt-muted">{groupName}</div>
              <ul>
                {groupItems.map((it) => {
                  runningIdx++;
                  const active = runningIdx === cursor;
                  const cls = `flex items-center justify-between px-4 py-2.5 cursor-pointer transition-colors ${
                    active ? "bg-ari-soft text-ari-violet-700" : "hover:bg-ari-canvas"
                  }`;
                  const inner = (
                    <>
                      <span className="font-medium text-[14px]">{it.label}</span>
                      {it.hint && <span className="text-xs text-txt-muted">{it.hint}</span>}
                    </>
                  );
                  return (
                    <li key={it.label}>
                      {it.href ? (
                        <Link href={it.href} className={cls} onClick={onClose}>{inner}</Link>
                      ) : (
                        <button onClick={() => { it.action?.(); onClose(); }} className={`w-full text-left ${cls}`}>{inner}</button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
        <div className="border-t border-ari-border bg-ari-canvas px-4 py-2 flex justify-between text-xs text-txt-muted">
          <span><kbd className="font-mono">↑↓</kbd> navigate</span>
          <span><kbd className="font-mono">↵</kbd> open</span>
          <span><kbd className="font-mono">⌘K</kbd> toggle</span>
        </div>
      </div>
    </div>
  );
}
