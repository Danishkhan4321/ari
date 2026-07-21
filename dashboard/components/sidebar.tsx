"use client";

// Ari dashboard sidebar. Same visual
// language (white card sidebar with cyan-tinted active state, account
// block at top, footer status indicator) but every link points at the
// real app routes and the account block reads from /api/me.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

type Me = { user_phone: string; name: string; email: string | null; tier: string | null };

const NAV: { id: string; label: string; href: string }[] = [
  { id: "home",         label: "Home",            href: "/" },
  { id: "chat",         label: "Chat",            href: "/chat" },
  { id: "reminders",    label: "Reminders",       href: "/reminders" },
  { id: "tasks",        label: "Tasks",           href: "/tasks" },
  { id: "contacts",     label: "Contacts & CRM",  href: "/contacts" },
  { id: "inbox",        label: "Inbox",           href: "/inbox" },
  { id: "meetings",     label: "Meetings",        href: "/meetings" },
  { id: "team",         label: "Team",            href: "/team" },
];
const SETTINGS_NAV = [{ id: "settings", label: "Settings", href: "/settings" }];

export function Sidebar({ userPhone, onOpenCmdK }: { userPhone: string; onOpenCmdK: () => void }) {
  const pathname = usePathname() ?? "/";
  const [me, setMe] = useState<Me | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => { setMobileOpen(false); }, [pathname]);
  useEffect(() => {
    fetch("/api/me", { cache: "no-store" })
      .then(r => r.json())
      .then((d: { ok: boolean; user_phone?: string; name?: string; email?: string | null; tier?: string | null }) => {
        if (d?.ok) setMe({ user_phone: d.user_phone || userPhone, name: d.name || `+${userPhone}`, email: d.email || null, tier: d.tier || null });
      })
      .catch(() => { /* fall back to phone-only */ });
  }, [userPhone]);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");

  const initial = (me?.name || `+${userPhone}`).replace(/^\+/, "").charAt(0).toUpperCase();
  const tierLabel = me?.tier ? me.tier.charAt(0).toUpperCase() + me.tier.slice(1) : null;

  return (
    <>
      {/* Mobile top bar */}
      <header className="lg:hidden sticky top-0 z-30 bg-ari-canvas/85 backdrop-blur-md border-b border-ari-border px-4 py-3 flex items-center justify-between">
        <button
          aria-label="Open menu"
          onClick={() => setMobileOpen(true)}
          className="w-9 h-9 border border-ari-border rounded-md bg-white flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-lavender"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M2 4h12M2 8h12M2 12h12" stroke="#0a0a0a" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <Link href="/" className="flex items-center gap-2">
          <span className="w-8 h-8 rounded-[9px] bg-ari-midnight grid place-items-center shadow-[0_5px_14px_rgba(90,55,214,0.18)]">
            <img src="/ari-mark.svg" alt="Ari" className="w-6 h-6" draggable={false} />
          </span>
          <span className="font-semibold text-[14px] tracking-tight">Ari</span>
        </Link>
        <button
          aria-label="Open command palette"
          onClick={onOpenCmdK}
          className="w-9 h-9 border border-ari-border rounded-md bg-white flex items-center justify-center text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-lavender"
        >
          ⌘K
        </button>
      </header>

      {/* Mobile drawer overlay */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-40 bg-black/30" onClick={() => setMobileOpen(false)} />
      )}

      <aside
        className={`
          fixed lg:sticky top-0 left-0 z-50 lg:z-10
          h-screen w-[240px] flex-shrink-0
          bg-white border-r border-ari-border
          flex flex-col
          transition-transform duration-200
          ${mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}
        `}
      >
        {/* Brand */}
        <Link href="/" className="px-4 h-16 flex items-center gap-2.5 border-b border-ari-border flex-shrink-0">
          <div className="w-9 h-9 rounded-[10px] bg-ari-midnight flex items-center justify-center shadow-[0_6px_16px_rgba(90,55,214,0.2)]">
            <img
              src="/ari-mark.svg"
              alt="Ari"
              className="w-7 h-7 object-contain"
              draggable={false}
            />
          </div>
          <div className="font-semibold text-[14px] tracking-tight">Ari</div>
          {tierLabel && (
            <div className="ml-auto text-[10px] font-semibold text-ari-violet-700 uppercase tracking-wider px-2 py-0.5 bg-ari-soft border border-ari-border-strong rounded-full">
              {tierLabel}
            </div>
          )}
          <button
            className="lg:hidden ml-auto w-7 h-7 flex items-center justify-center text-xl"
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
          >
            ×
          </button>
        </Link>

        {/* Account */}
        <div className="px-3 py-3 border-b border-ari-border flex-shrink-0">
          <Link
            href="/settings"
            className="w-full flex items-center gap-2.5 px-2 py-2 rounded-md hover:bg-ari-subtle transition-colors text-left"
          >
            <div className="w-8 h-8 rounded-[9px] bg-gradient-to-br from-ari-violet-400 to-ari-violet-600 text-white flex items-center justify-center text-[12px] font-bold flex-shrink-0 shadow-[0_5px_12px_rgba(90,55,214,0.18)]">
              {initial}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium truncate">{me?.name || `+${userPhone}`}</div>
              <div className="text-[11px] text-[#737373] truncate">{me?.email || "WhatsApp account"}</div>
            </div>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M5 6.5l3 3 3-3" stroke="#737373" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
        </div>

        {/* Search trigger (opens cmd-k) */}
        <div className="px-3 py-3 border-b border-ari-border flex-shrink-0">
          <button
            onClick={onOpenCmdK}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[12.5px] text-ari-muted bg-ari-canvas border border-ari-border rounded-md hover:border-ari-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-lavender transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="text-[#a3a3a3]">
              <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.4" />
              <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            <span className="flex-1 text-left">Search…</span>
            <kbd className="text-[10px] font-medium text-[#737373] bg-white border border-[#E8E3ED] rounded px-1.5 py-0.5">⌘K</kbd>
          </button>
        </div>

        {/* Nav */}
        <nav className="px-2 py-3 flex-1 overflow-y-auto">
          <div className="dash-label px-2 mb-2">Workspace</div>
          <div className="space-y-0.5">
            {NAV.map((item) => {
              const active = isActive(item.href);
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  className={`relative w-full flex items-center gap-2.5 px-2 py-2 rounded-md text-[13px] font-medium transition-all ${
                    active
                      ? "bg-ari-soft text-ari-violet-700 border border-ari-border-strong before:absolute before:-left-[1px] before:top-2 before:bottom-2 before:w-[3px] before:rounded-r before:bg-ari-violet-500"
                      : "text-[#625b69] hover:bg-ari-subtle hover:text-ari-text border border-transparent"
                  }`}
                >
                  <NavIcon name={item.id} active={active} />
                  <span className="flex-1 text-left">{item.label}</span>
                </Link>
              );
            })}
          </div>

          <div className="dash-label px-2 mb-2 mt-6">Settings</div>
          <div className="space-y-0.5">
            {SETTINGS_NAV.map((s) => {
              const active = isActive(s.href);
              return (
                <Link
                  key={s.id}
                  href={s.href}
                  className={`relative w-full flex items-center gap-2.5 px-2 py-2 rounded-md text-[13px] font-medium transition-all ${
                    active
                      ? "bg-ari-soft text-ari-violet-700 border border-ari-border-strong before:absolute before:-left-[1px] before:top-2 before:bottom-2 before:w-[3px] before:rounded-r before:bg-ari-violet-500"
                      : "text-[#625b69] hover:bg-ari-subtle hover:text-ari-text border border-transparent"
                  }`}
                >
                  <NavIcon name={s.id} active={active} />
                  <span className="flex-1 text-left">{s.label}</span>
                </Link>
              );
            })}
          </div>
        </nav>

        {/* Footer */}
        <div className="border-t border-ari-border p-3 flex items-center justify-between text-[11px] text-[#625b69] flex-shrink-0">
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-ari-violet-500 shadow-[0_0_0_3px_rgba(216,204,255,0.55)]" />
            All systems normal
          </div>
          <form action="/api/auth/logout" method="POST">
            <button type="submit" className="text-[#737373] hover:text-[#0a0a0a] transition-colors">
              Sign out
            </button>
          </form>
        </div>
      </aside>
    </>
  );
}

// Sidebar nav icon set — line icons matched to the demo's stroke style.
function NavIcon({ name, active = false }: { name: string; active?: boolean }) {
  const stroke = active ? "#5A37D6" : "#817987";
  const sw = active ? 1.7 : 1.5;
  const props = {
    width: 14,
    height: 14,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke,
    strokeWidth: sw,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "home":
      return (
        <svg {...props}>
          <rect x="2" y="2" width="5" height="5" />
          <rect x="9" y="2" width="5" height="5" />
          <rect x="2" y="9" width="5" height="5" />
          <rect x="9" y="9" width="5" height="5" />
        </svg>
      );
    case "chat":
      return (
        <svg {...props}>
          <path d="M2 4a1 1 0 011-1h10a1 1 0 011 1v6a1 1 0 01-1 1H6l-3 3v-3H3a1 1 0 01-1-1V4z" />
        </svg>
      );
    case "contacts":
      return (
        <svg {...props}>
          <circle cx="8" cy="6" r="2.5" />
          <path d="M3 14c.5-2.5 2.5-3.8 5-3.8s4.5 1.3 5 3.8" />
        </svg>
      );
    case "inbox":
      return (
        <svg {...props}>
          <rect x="2" y="3" width="12" height="10" rx="1" />
          <path d="M2 5l6 4 6-4" />
        </svg>
      );
    case "notes":
      return (
        <svg {...props}>
          <rect x="3" y="2" width="10" height="12" rx="1" />
          <path d="M5.5 5h5M5.5 8h5M5.5 11h3" />
        </svg>
      );
    case "productivity":
      return (
        <svg {...props}>
          <path d="M2 13l4-6 3 3 5-7" />
          <path d="M2 13h12" />
        </svg>
      );
    case "settings":
      return (
        <svg {...props}>
          <circle cx="8" cy="8" r="2" />
          <path d="M8 1v2M8 13v2M3 3l1.5 1.5M11.5 11.5L13 13M1 8h2M13 8h2M3 13l1.5-1.5M11.5 4.5L13 3" />
        </svg>
      );
    case "reminders":
      return (
        <svg {...props}>
          <circle cx="8" cy="8" r="6" />
          <path d="M8 5v3l2 2" />
        </svg>
      );
    case "tasks":
      return (
        <svg {...props}>
          <rect x="2" y="2" width="12" height="12" rx="1.5" />
          <path d="M5 8l2 2 4-4" />
        </svg>
      );
    case "meetings":
      return (
        <svg {...props}>
          <rect x="1.5" y="4" width="9" height="8" rx="1" />
          <path d="M10.5 7l4-2v6l-4-2" />
        </svg>
      );
    case "team":
      return (
        <svg {...props}>
          <circle cx="6" cy="6" r="2.5" />
          <circle cx="11.5" cy="7" r="2" />
          <path d="M1.5 13c.5-2.5 2.5-3.5 4.5-3.5s4 1 4.5 3.5M11.5 9c1.5 0 3 1 3 3" />
        </svg>
      );
    default:
      return (
        <svg {...props}>
          <circle cx="8" cy="8" r="2" />
        </svg>
      );
  }
}
