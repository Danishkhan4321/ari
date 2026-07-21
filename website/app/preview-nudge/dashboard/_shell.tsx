"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/* ════════════════════════════════════════════════════════════════
   Shared dashboard shell.
   Used by every /preview-nudge/dashboard/* page.
   Provides: scoped CSS, sidebar, topbar, layout grid.
   ════════════════════════════════════════════════════════════════ */

export function DashboardStyles() {
  return (
    <style jsx global>{`
      .dash {
        font-family: "Inter", "Plus Jakarta Sans", system-ui, sans-serif;
        font-feature-settings: "cv11", "ss01";
        -webkit-font-smoothing: antialiased;
      }
      .dash .num {
        font-variant-numeric: tabular-nums;
        font-feature-settings: "tnum", "cv11";
      }
      .dash-label {
        font-size: 11px;
        font-weight: 500;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: #737373;
      }
      .dash-h1 {
        font-weight: 600;
        letter-spacing: -0.022em;
        line-height: 1.15;
      }
      .dash-h2 {
        font-size: 13.5px;
        font-weight: 600;
        letter-spacing: -0.005em;
      }
      .dash-card {
        background: #ffffff;
        border: 1px solid #e8e6dc;
        border-radius: 10px;
      }
      .dash-card-hero {
        background: #ffffff;
        border: 1.5px solid #0a0a0a;
        border-radius: 12px;
        box-shadow: 4px 4px 0 #0a0a0a;
      }
      .dash-input {
        font-family: inherit;
        font-size: 13px;
        background: #ffffff;
        border: 1px solid #e8e6dc;
        border-radius: 8px;
        padding: 9px 12px;
        outline: none;
        transition: border-color 0.15s, box-shadow 0.15s;
      }
      .dash-input:focus {
        border-color: #0a0a0a;
        box-shadow: 2px 2px 0 #0a0a0a;
      }
      .dash-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-family: inherit;
        font-size: 13px;
        font-weight: 500;
        background: #ffffff;
        border: 1px solid #e8e6dc;
        border-radius: 8px;
        padding: 7px 12px;
        color: #171717;
        cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
      }
      .dash-btn:hover {
        background: #fbfaf3;
        border-color: #0a0a0a;
      }
      .dash-btn-primary {
        background: #0a0a0a;
        color: #ffffff;
        border-color: #0a0a0a;
        box-shadow: 2px 2px 0 #0a0a0a;
      }
      .dash-btn-primary:hover {
        background: #262626;
        border-color: #262626;
        transform: translate(1px, 1px);
        box-shadow: 1px 1px 0 #0a0a0a;
      }
      .dash-pill {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 3px 8px;
        font-size: 11px;
        font-weight: 500;
        line-height: 1;
        border: 1px solid #e8e6dc;
        background: #fbfaf3;
        border-radius: 999px;
      }
      .dash-tab {
        font-size: 12.5px;
        font-weight: 500;
        padding: 6px 12px;
        border-radius: 7px;
        color: #525252;
        cursor: pointer;
        transition: background 0.15s, color 0.15s;
      }
      .dash-tab:hover {
        background: #fbfaf3;
        color: #0a0a0a;
      }
      .dash-tab-active {
        background: #0a0a0a;
        color: #ffffff;
      }
      .dash-tab-active:hover {
        background: #262626;
        color: #ffffff;
      }
    `}</style>
  );
}

/* Sidebar nav — mirrors the Ari desktop dashboard nav order exactly. */
export const sidebarNav = [
  { id: "home",         label: "Home",            href: "/preview-nudge/dashboard",              count: null as number | null },
  { id: "chat",         label: "Chat",            href: "/preview-nudge/dashboard/chat",         count: null },
  { id: "reminders",    label: "Reminders",       href: "/preview-nudge/dashboard/reminders",    count: 12 },
  { id: "tasks",        label: "Tasks",           href: "/preview-nudge/dashboard/tasks",        count: 7 },
  { id: "contacts",     label: "Contacts & CRM",  href: "/preview-nudge/dashboard/contacts",     count: 184 },
  { id: "inbox",        label: "Inbox",           href: "/preview-nudge/dashboard/email",        count: 23 },
  { id: "meetings",     label: "Meetings",        href: "/preview-nudge/dashboard/meetings",     count: 2 },
  { id: "team",         label: "Team",            href: "/preview-nudge/dashboard/team",         count: null },
  { id: "notes",        label: "Notes & KB",      href: "/preview-nudge/dashboard/notes",        count: 412 },
  { id: "productivity", label: "Productivity",    href: "/preview-nudge/dashboard/productivity", count: null },
];

/* Single Settings entry now (production has just `/settings`); the
   Integrations / Billing / Preferences split lives as tabs inside it. */
export const sidebarSettings = [
  { id: "settings", label: "Settings", href: "/preview-nudge/dashboard/settings" },
];

/* ───────── Sidebar ───────── */
function Sidebar() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/preview-nudge/dashboard"
      ? pathname === href
      : pathname?.startsWith(href);
  return (
    <aside className="hidden lg:flex flex-col w-[240px] border-r border-[#e8e6dc] bg-white sticky top-0 h-screen flex-shrink-0">
      {/* Brand */}
      <Link
        href="/preview-nudge/dashboard"
        className="px-4 h-16 flex items-center gap-2.5 border-b border-[#e8e6dc]"
      >
        <div className="relative w-8 h-8 flex items-center justify-center">
          <span className="absolute inset-0 rounded-full bg-[#9BE7BF] opacity-50 blur-sm" />
          <img
            src="/logo-wolf.png"
            alt="Ari"
            className="relative w-8 h-8 object-contain"
            draggable={false}
          />
        </div>
        <div className="font-semibold text-[14px] tracking-tight">Ari</div>
        <div className="ml-auto text-[10px] font-semibold text-[#0a0a0a] uppercase tracking-wider px-2 py-0.5 bg-[#FFE38C] border border-[#0a0a0a] rounded">
          Pro
        </div>
      </Link>

      {/* Account */}
      <div className="px-3 py-3 border-b border-[#e8e6dc]">
        <button className="w-full flex items-center gap-2.5 px-2 py-2 rounded-md hover:bg-[#fbfaf3] transition-colors text-left">
          <div className="w-8 h-8 rounded-full bg-[#FF9D6E] border border-[#0a0a0a] text-[#0a0a0a] flex items-center justify-center text-[12px] font-bold flex-shrink-0">
            A
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-medium truncate">Danish</div>
            <div className="text-[11px] text-[#737373] truncate">danish@ari.local</div>
          </div>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M5 6.5l3 3 3-3"
              stroke="#737373"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {/* Nav */}
      <nav className="px-2 py-3 flex-1 overflow-y-auto">
        <div className="dash-label px-2 mb-2">Workspace</div>
        <div className="space-y-0.5">
          {sidebarNav.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.id}
                href={item.href}
                className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-md text-[13px] font-medium transition-all ${
                  active
                    ? "bg-[#7BD3F7]/30 text-[#0a0a0a] border border-[#0a0a0a]"
                    : "text-[#525252] hover:bg-[#fbfaf3] hover:text-[#0a0a0a] border border-transparent"
                }`}
              >
                <NavIcon name={item.id} active={active} />
                <span className="flex-1 text-left">{item.label}</span>
                {item.count !== null && (
                  <span
                    className={`text-[11px] num ${
                      active ? "text-[#0a0a0a] font-semibold" : "text-[#737373]"
                    }`}
                  >
                    {item.count}
                  </span>
                )}
              </Link>
            );
          })}
        </div>

        <div className="dash-label px-2 mb-2 mt-6">Settings</div>
        <div className="space-y-0.5">
          {sidebarSettings.map((s) => {
            const active = isActive(s.href);
            return (
              <Link
                key={s.id}
                href={s.href}
                className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-md text-[13px] font-medium transition-all ${
                  active
                    ? "bg-[#7BD3F7]/30 text-[#0a0a0a] border border-[#0a0a0a]"
                    : "text-[#525252] hover:bg-[#fbfaf3] hover:text-[#0a0a0a] border border-transparent"
                }`}
              >
                <NavIcon name={s.id} active={active} />
                <span className="flex-1 text-left">{s.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>

      {/* Bottom */}
      <div className="border-t border-[#e8e6dc] p-3 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[11px] text-[#525252]">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#3FAA6E]" />
          All systems normal
        </div>
        <Link
          href="/preview-nudge"
          className="text-[11px] text-[#737373] hover:text-[#0a0a0a]"
        >
          ← Site
        </Link>
      </div>
    </aside>
  );
}

/* ───────── Topbar ───────── */
function Topbar({ title }: { title?: string }) {
  return (
    <header className="sticky top-0 z-30 bg-[#fbfaf3]/85 backdrop-blur-md border-b border-[#e8e6dc]">
      <div className="px-6 lg:px-12 h-16 flex items-center justify-between gap-4">
        {/* Search */}
        <div className="relative flex-1 max-w-[420px]">
          <svg
            width="13"
            height="13"
            viewBox="0 0 16 16"
            fill="none"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[#a3a3a3]"
          >
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.4" />
            <path
              d="M11 11l3 3"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
          <input
            type="text"
            placeholder={`Search ${title?.toLowerCase() ?? "anything"}…`}
            className="dash-input w-full pl-8 pr-12 py-2"
          />
          <kbd className="hidden md:flex absolute right-2 top-1/2 -translate-y-1/2 items-center text-[10px] font-medium text-[#737373] bg-[#fbfaf3] border border-[#e8e6dc] rounded px-1.5 py-0.5">
            ⌘ K
          </kbd>
        </div>

        <div className="flex items-center gap-2">
          <button
            className="relative w-8 h-8 border border-[#e8e6dc] rounded-md flex items-center justify-center hover:bg-[#fbfaf3] transition-colors"
            aria-label="Notifications"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M8 1.5a3 3 0 00-3 3v3.5L3 10v1h10v-1l-2-2.5V4.5a3 3 0 00-3-3zM6 12a2 2 0 104 0"
                stroke="#525252"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
            <span className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-[#ef4444] text-[9px] text-white font-semibold flex items-center justify-center">
              3
            </span>
          </button>
          <Link href="/preview-nudge" className="dash-btn">
            ← Marketing
          </Link>
          <button className="dash-btn dash-btn-primary">
            <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor">
              <path d="M5 1h2v4h4v2H7v4H5V7H1V5h4z" />
            </svg>
            New
          </button>
        </div>
      </div>
    </header>
  );
}

/* ───────── Page header (title + breadcrumb + actions) ───────── */
export function PageHead({
  title,
  subtitle,
  badge,
  actions,
}: {
  title: string;
  subtitle?: string;
  badge?: { label: string; color: string };
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-end justify-between flex-wrap gap-6 mb-10">
      <div>
        <div className="dash-label mb-3 flex items-center gap-2">
          {badge && (
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{ background: badge.color }}
            />
          )}
          {badge?.label ?? "Workspace"}
        </div>
        <h1 className="dash-h1 text-[28px]">{title}</h1>
        {subtitle && (
          <p className="text-[13.5px] text-[#737373] mt-2.5 leading-relaxed max-w-xl">
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/* ───────── Shell wrapper ───────── */
export function DashboardShell({
  children,
  title,
}: {
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <div className="dash bg-[#fbfaf3] text-[#0a0a0a] min-h-screen">
      <DashboardStyles />
      <PreviewBanner />
      <div className="flex min-h-screen">
        <Sidebar />
        <main className="flex-1 min-w-0">
          <Topbar title={title} />
          <div className="px-6 lg:px-12 py-12 lg:py-14 max-w-[1240px]">
            {children}
            <DashboardFooter />
          </div>
        </main>
      </div>
    </div>
  );
}

// Sticky banner that makes it impossible to mistake the marketing demo
// for the user's real dashboard. Sample data is "Danish", "Demo for Acme",
// etc. — the banner directs anyone here for legit reasons to the actual
// local Ari desktop app.
function PreviewBanner() {
  return (
    <div className="sticky top-0 z-[60] bg-[#FFE38C] border-b-[1.5px] border-black">
      <div className="max-w-[1240px] mx-auto px-4 lg:px-6 py-2.5 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="inline-flex items-center px-2 py-0.5 bg-black text-white text-[10px] font-bold tracking-[0.15em] uppercase rounded-[3px]">
            Preview
          </span>
          <span className="text-[12.5px] lg:text-[13px] font-medium leading-snug">
            This is a demo with sample data — not your real dashboard.
          </span>
        </div>
        <a
          href="http://127.0.0.1:43101"
          className="inline-flex items-center gap-1.5 bg-black text-white text-[12px] font-semibold tracking-wide px-3 py-1.5 rounded-[5px] hover:opacity-90 whitespace-nowrap"
        >
          Open Ari Desktop →
        </a>
      </div>
    </div>
  );
}

function DashboardFooter() {
  return (
    <div className="mt-14 pb-10 flex items-center justify-between text-[11px] text-[#a3a3a3]">
      <div>© Ari 2026 · Dashboard preview</div>
      <div className="flex items-center gap-4">
        <span>v0.1.0</span>
        <span className="w-px h-3 bg-[#e8e6dc]" />
        <Link
          href="/preview-nudge/privacy"
          className="hover:text-[#0a0a0a] transition-colors"
        >
          Privacy
        </Link>
        <Link
          href="/preview-nudge/terms"
          className="hover:text-[#0a0a0a] transition-colors"
        >
          Terms
        </Link>
      </div>
    </div>
  );
}

/* ───────── Empty state ───────── */
export function EmptyState({
  icon,
  title,
  body,
  cta,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  cta?: React.ReactNode;
}) {
  return (
    <div className="dash-card p-10 text-center">
      <div className="w-12 h-12 rounded-full bg-[#fbfaf3] border border-[#e8e6dc] flex items-center justify-center mx-auto mb-4 text-[#737373]">
        {icon}
      </div>
      <div className="dash-h2 text-[15px]">{title}</div>
      <p className="text-[13px] text-[#737373] mt-2 max-w-sm mx-auto leading-relaxed">
        {body}
      </p>
      {cta && <div className="mt-5">{cta}</div>}
    </div>
  );
}

/* ───────── Status pill ───────── */
export function StatusPill({
  color,
  children,
}: {
  color: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className="dash-pill"
      style={{ background: color + "1A", borderColor: color + "55", color: "#0a0a0a" }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{ background: color }}
      />
      {children}
    </span>
  );
}

/* ───────── Tabs ───────── */
export function Tabs({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string; count?: number }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex gap-1 bg-white border border-[#e8e6dc] rounded-lg p-1">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`dash-tab ${value === o.value ? "dash-tab-active" : ""}`}
        >
          {o.label}
          {o.count !== undefined && (
            <span
              className={`ml-1.5 num text-[10px] ${
                value === o.value ? "text-white/65" : "text-[#a3a3a3]"
              }`}
            >
              {o.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/* ───────── Live local clock (compact for topbar / hero chip) ───────── */
export function useLocalClock() {
  const [time, setTime] = useState("");
  const [date, setDate] = useState("");
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const hh = d.getHours();
      const mm = String(d.getMinutes()).padStart(2, "0");
      setTime(`${hh % 12 || 12}:${mm} ${hh >= 12 ? "PM" : "AM"}`);
      setDate(
        d.toLocaleDateString("en-US", {
          weekday: "long",
          day: "numeric",
          month: "long",
        })
      );
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);
  return { time, date };
}

/* ───────── Sidebar nav icon set ───────── */
function NavIcon({ name, active = false }: { name: string; active?: boolean }) {
  const stroke = active ? "#0a0a0a" : "#737373";
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
    case "overview":
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
    case "email":
      return (
        <svg {...props}>
          <rect x="2" y="3" width="12" height="10" rx="1" />
          <path d="M2 5l6 4 6-4" />
        </svg>
      );
    case "notes":
    case "memory":
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
    case "calendar":
      return (
        <svg {...props}>
          <rect x="2" y="3" width="12" height="11" rx="1" />
          <path d="M5 1.5v3M11 1.5v3M2 6.5h12" />
        </svg>
      );
    case "tasks":
      return (
        <svg {...props}>
          <rect x="2" y="2" width="12" height="12" rx="1.5" />
          <path d="M5 8l2 2 4-4" />
        </svg>
      );
    case "email":
      return (
        <svg {...props}>
          <rect x="2" y="3" width="12" height="10" rx="1" />
          <path d="M2 5l6 4 6-4" />
        </svg>
      );
    case "meetings":
      return (
        <svg {...props}>
          <rect x="1.5" y="4" width="9" height="8" rx="1" />
          <path d="M10.5 7l4-2v6l-4-2" />
        </svg>
      );
    case "memory":
      return (
        <svg {...props}>
          <path d="M8 1.5C5 1.5 3 3.5 3 6c0 1 .3 2 1 3v4l1.5-1h5L12 13V9c.7-1 1-2 1-3 0-2.5-2-4.5-5-4.5z" />
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
    case "integrations":
      return (
        <svg {...props}>
          <path d="M5.5 1.5v4M10.5 1.5v4M3 5.5h10v3a4 4 0 01-4 4h-2a4 4 0 01-4-4v-3zM7 12.5v2" />
        </svg>
      );
    case "billing":
      return (
        <svg {...props}>
          <rect x="1.5" y="3.5" width="13" height="9" rx="1" />
          <path d="M1.5 6.5h13M4 10h2" />
        </svg>
      );
    case "preferences":
      return (
        <svg {...props}>
          <circle cx="8" cy="8" r="2" />
          <path d="M8 1v2M8 13v2M3 3l1.5 1.5M11.5 11.5L13 13M1 8h2M13 8h2M3 13l1.5-1.5M11.5 4.5L13 3" />
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
