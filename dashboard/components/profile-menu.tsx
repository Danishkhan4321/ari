"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AriMark, SectionIcon } from "./icons";

export function ProfileMenu({ userPhone }: { userPhone: string }) {
  const pathname = usePathname() || "/";
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <div className="relative border-t border-ari-border p-2">
      {open && (
        <>
          <button type="button" aria-label="Close profile menu" className="fixed inset-0 z-30 cursor-default bg-transparent" onClick={() => setOpen(false)} />
          <div role="menu" aria-label="Profile menu" className="absolute inset-x-2 bottom-full z-40 mb-1.5 rounded-lg border border-ari-border bg-white p-1.5 shadow-[0_14px_34px_rgba(42,30,60,0.14)]">
            <Link
              href="/settings"
              role="menuitem"
              className="flex h-9 items-center gap-2 rounded-md px-2.5 text-[12.5px] font-medium text-[#514b58] transition hover:bg-ari-soft hover:text-ari-violet-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-lavender"
            >
              <SectionIcon section="settings" className="h-4 w-4" />
              <span>Settings</span>
            </Link>
          </div>
        </>
      )}

      <button
        type="button"
        aria-label="Open profile menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-lavender"
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-ari-midnight"><AriMark className="h-5 w-5" /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-semibold">Personal workspace</span>
          <span className="block truncate text-[11px] text-ari-muted">{maskAccount(userPhone)}</span>
        </span>
        <ChevronIcon open={open} />
      </button>
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg className={`h-3 w-3 shrink-0 text-ari-muted transition-transform ${open ? "rotate-180" : ""}`} viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function maskAccount(value: string): string {
  const clean = value.replace(/\s/g, "");
  return clean.length <= 5 ? clean : `${clean.slice(0, 3)}••••${clean.slice(-3)}`;
}
