"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/* ── Feature mega-menu items with SVG icons ── */
const featureItems = [
  {
    label: "Memory & Reminders",
    href: "/features#memory-reminders",
    desc: "Never forget anything — one-time, recurring, or smart nudges.",
    icon: (
      <svg viewBox="0 0 32 32" fill="none" className="w-8 h-8">
        <circle cx="16" cy="16" r="12" fill="#818CF8" stroke="#000" strokeWidth="2" />
        <circle cx="16" cy="16" r="4" fill="#7DFFB3" stroke="#000" strokeWidth="1.5" />
        <path d="M16 8v4" stroke="#000" strokeWidth="2" strokeLinecap="round" />
        <path d="M16 20v4" stroke="#000" strokeWidth="2" strokeLinecap="round" />
        <path d="M8 16h4" stroke="#000" strokeWidth="2" strokeLinecap="round" />
        <path d="M20 16h4" stroke="#000" strokeWidth="2" strokeLinecap="round" />
        <path d="M16 16l3-5" stroke="#FD693F" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M16 16l-2 3" stroke="#4ADBC8" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    label: "Calendar & Scheduling",
    href: "/features#calendar-scheduling",
    desc: "Google + Outlook + Apple unified in one chat view.",
    icon: (
      <svg viewBox="0 0 32 32" fill="none" className="w-8 h-8">
        <rect x="4" y="6" width="24" height="22" rx="3" fill="#fff" stroke="#000" strokeWidth="2" />
        <rect x="4" y="6" width="24" height="8" rx="3" fill="#4ADBC8" stroke="#000" strokeWidth="2" />
        <path d="M10 3v5M22 3v5" stroke="#000" strokeWidth="2" strokeLinecap="round" />
        <rect x="9" y="18" width="4" height="3" rx="1" fill="#818CF8" />
        <rect x="15" y="18" width="4" height="3" rx="1" fill="#FD693F" />
        <rect x="21" y="18" width="4" height="3" rx="1" fill="#DAF464" />
        <rect x="9" y="23" width="4" height="3" rx="1" fill="#F2A3D8" />
        <rect x="15" y="23" width="4" height="3" rx="1" fill="#7DFFB3" />
      </svg>
    ),
  },
  {
    label: "Email & Communication",
    href: "/features#email-communication",
    desc: "Send, schedule, search & auto-organize from chat.",
    icon: (
      <svg viewBox="0 0 32 32" fill="none" className="w-8 h-8">
        <rect x="3" y="7" width="26" height="18" rx="3" fill="#FD693F" stroke="#000" strokeWidth="2" />
        <path d="M3 10l13 8 13-8" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="17" y="4" width="10" height="8" rx="4" fill="#7DFFB3" stroke="#000" strokeWidth="1.5" />
        <path d="M22 6.5v3M22 11v.5" stroke="#000" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    label: "Tasks & Projects",
    href: "/features#tasks-project-management",
    desc: "Kanban boards, sprint planning & velocity tracking.",
    icon: (
      <svg viewBox="0 0 32 32" fill="none" className="w-8 h-8">
        <rect x="4" y="4" width="24" height="24" rx="3" fill="#DAF464" stroke="#000" strokeWidth="2" />
        <path d="M10 12l3 3 6-6" stroke="#000" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M10 22h12" stroke="#000" strokeWidth="2" strokeLinecap="round" />
        <path d="M10 17h8" stroke="#818CF8" strokeWidth="2" strokeLinecap="round" />
        <circle cx="25" cy="7" r="4" fill="#FD693F" stroke="#000" strokeWidth="1.5" />
        <path d="M24 7h2M25 6v2" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    label: "Team & Collaboration",
    href: "/features#team-collaboration",
    desc: "Standups, polls, leave management & linked accounts.",
    icon: (
      <svg viewBox="0 0 32 32" fill="none" className="w-8 h-8">
        <circle cx="11" cy="10" r="5" fill="#818CF8" stroke="#000" strokeWidth="2" />
        <circle cx="22" cy="10" r="4" fill="#4ADBC8" stroke="#000" strokeWidth="2" />
        <path d="M3 28v-3a6 6 0 0112 0v3" fill="#F2A3D8" stroke="#000" strokeWidth="2" strokeLinecap="round" />
        <path d="M19 28v-2a5 5 0 015-5" stroke="#000" strokeWidth="2" strokeLinecap="round" />
        <circle cx="27" cy="6" r="3" fill="#DAF464" stroke="#000" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    label: "Sales & CRM",
    href: "/features#sales-crm",
    desc: "Track leads, draft cold emails & manage deals.",
    icon: (
      <svg viewBox="0 0 32 32" fill="none" className="w-8 h-8">
        <circle cx="16" cy="16" r="13" fill="#7DFFB3" stroke="#000" strokeWidth="2" />
        <path d="M16 6v20" stroke="#000" strokeWidth="2" strokeLinecap="round" />
        <path d="M20 10h-5.5a3 3 0 000 6h3a3 3 0 010 6H11" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="26" cy="6" r="4" fill="#FD693F" stroke="#000" strokeWidth="1.5" />
        <path d="M25 4l2 2 3-3" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    label: "Meeting Recorder",
    href: "/meet",
    desc: "Record system + mic audio and generate reports.",
    icon: (
      <svg viewBox="0 0 32 32" fill="none" className="w-8 h-8">
        <rect x="3" y="8" width="18" height="16" rx="3" fill="#818CF8" stroke="#000" strokeWidth="2" />
        <path d="M21 13l7-4v14l-7-4v-6z" fill="#4ADBC8" stroke="#000" strokeWidth="2" strokeLinejoin="round" />
        <circle cx="12" cy="16" r="3" fill="#FD693F" stroke="#000" strokeWidth="1.5" />
        <circle cx="8" cy="5" r="3" fill="#DAF464" stroke="#000" strokeWidth="1.5" />
        <path d="M7 4l2 2" stroke="#000" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    label: "Daily Briefing",
    href: "/features#daily-briefing",
    desc: "Every morning: meetings, tasks & priorities in one message.",
    icon: (
      <svg viewBox="0 0 32 32" fill="none" className="w-8 h-8">
        <rect x="6" y="3" width="20" height="26" rx="3" fill="#fff" stroke="#000" strokeWidth="2" />
        <rect x="6" y="3" width="20" height="8" rx="3" fill="#F2A3D8" stroke="#000" strokeWidth="2" />
        <path d="M11 15h10M11 20h6" stroke="#000" strokeWidth="2" strokeLinecap="round" />
        <circle cx="22" cy="7" r="3" fill="#7DFFB3" stroke="#000" strokeWidth="1.5" />
        <rect x="3" y="12" width="6" height="6" rx="1" fill="#DAF464" stroke="#000" strokeWidth="1.5" />
        <path d="M5 15h2" stroke="#000" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    label: "Personal Productivity",
    href: "/features#personal-productivity",
    desc: "Focus mode, habits, expenses & web search.",
    icon: (
      <svg viewBox="0 0 32 32" fill="none" className="w-8 h-8">
        <path d="M17 3L5 19h10l-2 10L27 13H17l2-10z" fill="#DAF464" stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="10" cy="6" r="3" fill="#818CF8" stroke="#000" strokeWidth="1.5" />
        <circle cx="26" cy="24" r="4" fill="#FD693F" stroke="#000" strokeWidth="1.5" />
        <path d="M24.5 24l1.5 1.5 2.5-2.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
];

const aboutItems = [
  { label: "About", href: "/about", desc: "Why we built Ari" },
  { label: "FAQ", href: "/faq", desc: "Questions, answered" },
];

const navLinks = [
  {
    label: "Features",
    href: "/features",
    icon: (
      <svg viewBox="0 0 20 20" fill="none" className="w-[18px] h-[18px]" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 2L12.5 7.5L18 8.5L14 12.5L15 18L10 15.5L5 18L6 12.5L2 8.5L7.5 7.5L10 2Z" />
      </svg>
    ),
  },
  {
    label: "Meet Bot",
    href: "/meet",
    icon: (
      <svg viewBox="0 0 20 20" fill="none" className="w-[18px] h-[18px]" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="4" width="11" height="11" rx="2" />
        <path d="M13 8l4.5-2.5v9L13 12" />
      </svg>
    ),
  },
  {
    label: "About",
    href: "/about",
    icon: (
      <svg viewBox="0 0 20 20" fill="none" className="w-[18px] h-[18px]" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="10" cy="7" r="4" />
        <path d="M3 18v-1a5 5 0 0110 0v1M14 5a4 4 0 011 7.9M17 18v-1a4 4 0 00-2-3.5" />
      </svg>
    ),
  },
];

/* ── Features Mega Menu ── */
function FeaturesMegaMenu({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute top-full left-1/2 -translate-x-1/2 pt-8 z-50 w-[820px]">
      <div className="bg-white border-2 border-black rounded-[4px] shadow-brutal-lg overflow-hidden">
        {/* Arrow pointer */}
        <div className="absolute -top-[6px] left-1/2 -translate-x-1/2 mt-8">
          <div className="w-3 h-3 bg-white border-l-2 border-t-2 border-black rotate-45 -translate-y-[2px]" />
        </div>

        {/* Grid of feature items */}
        <div className="grid grid-cols-3 gap-0 p-3">
          {featureItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={onClose}
              className="flex items-start gap-3 px-4 py-3.5 rounded-[4px] hover:bg-card-lemon transition-colors duration-100 group"
            >
              <div className="flex-shrink-0 w-10 h-10 flex items-center justify-center">
                {item.icon}
              </div>
              <div className="min-w-0">
                <span className="block text-[14px] font-semibold text-black leading-tight">
                  {item.label}
                </span>
                <span className="block text-[12px] text-black/50 leading-snug mt-0.5 group-hover:text-black/70">
                  {item.desc}
                </span>
              </div>
            </Link>
          ))}
        </div>

        {/* Bottom CTA bar */}
        <div className="border-t-2 border-black bg-card-lemon/30 px-5 py-3 flex items-center justify-between">
          <span className="text-sm text-black/60">
            80+ AI tools across 8 categories
          </span>
          <Link
            href="/features"
            onClick={onClose}
            className="inline-flex items-center text-sm font-semibold bg-white border-[1.6px] border-black rounded-[4px] px-4 py-1.5 shadow-brutal hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-brutal-hover active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-all duration-150"
          >
            All 80+ AI Tools →
          </Link>
        </div>
      </div>
    </div>
  );
}

/* ── About Dropdown ── */
function AboutDropdown({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute top-full left-1/2 -translate-x-1/2 pt-8 z-50">
      <div className="bg-white border-2 border-black rounded-[4px] shadow-brutal-lg p-2 min-w-[240px]">
        <div className="absolute -top-[6px] left-1/2 -translate-x-1/2 mt-8">
          <div className="w-3 h-3 bg-white border-l-2 border-t-2 border-black rotate-45 -translate-y-[2px]" />
        </div>
        {aboutItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            onClick={onClose}
            className="flex flex-col px-4 py-2.5 rounded-[4px] hover:bg-card-lemon transition-colors duration-100 group"
          >
            <span className="text-[14px] font-semibold text-black">
              {item.label}
            </span>
            <span className="text-[12px] text-black/50 group-hover:text-black/70">
              {item.desc}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

/* ── Mobile Accordion ── */
function MobileDropdown({
  label,
  items,
  onClose,
}: {
  label: string;
  items: { label: string; href: string; desc: string }[];
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-black/10">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center justify-between w-full text-lg font-medium font-sans py-3 text-black"
      >
        {label}
        <svg
          className={`w-4 h-4 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          viewBox="0 0 20 12"
          fill="none"
        >
          <path
            d="M2 2L10 10L18 2"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <div
        className={`overflow-hidden transition-all duration-300 ${
          open ? "max-h-[500px] pb-2" : "max-h-0"
        }`}
      >
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            onClick={onClose}
            className="block pl-4 py-2 text-base font-sans text-black/70 hover:text-black transition-colors"
          >
            {item.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

/* ── Navbar ── */
export default function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pathname = usePathname();

  useEffect(() => {
    setOpenDropdown(null);
    setMobileOpen(false);
  }, [pathname]);

  // The new design has its own nav inside each page (PreviewNav from
  // _shared.tsx via PageShell), so the old global navbar should never render.
  return null;
  // eslint-disable-next-line no-unreachable
  if (pathname?.startsWith("/preview-nudge")) return null;

  const handleMouseEnter = (label: string) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setOpenDropdown(label);
  };

  const handleMouseLeave = () => {
    timeoutRef.current = setTimeout(() => setOpenDropdown(null), 350);
  };

  const renderDropdown = (label: string) => {
    if (label === "Features") return <FeaturesMegaMenu onClose={() => setOpenDropdown(null)} />;
    if (label === "About") return <AboutDropdown onClose={() => setOpenDropdown(null)} />;
    return null;
  };

  const hasDropdown = (label: string) => label === "Features" || label === "About";

  return (
    <>
      {/* Announcement Bar */}
      <div className="bg-card-lemon border-b-2 border-black">
        <div className="max-w-7xl mx-auto px-6 lg:px-10 py-2.5 flex items-center justify-center gap-3 flex-wrap text-center">
          <span className="text-sm sm:text-base font-medium font-sans">
            🚀 Ari is now available on WhatsApp.
          </span>
          <Link
            href="/features"
            className="inline-flex items-center text-sm font-medium bg-white border-[1.6px] border-black rounded-[4px] px-4 py-0.5 shadow-brutal hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-brutal-hover active:translate-x-[4px] active:translate-y-[4px] active:shadow-none transition-all duration-150"
          >
            Explore →
          </Link>
        </div>
      </div>

      {/* Main Nav */}
      <nav className="bg-transparent relative">
        <div className="max-w-7xl mx-auto px-4 lg:px-8 py-3">
          <div className="flex items-center justify-between h-[60px] bg-white border-2 border-black rounded-full px-6 lg:px-8 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
            {/* Logo */}
            <Link href="/" className="flex items-center gap-2">
              <img src="/logo-wolf.png" alt="Ari logo" width={32} height={32} className="rounded-md" />
              <span className="text-[22px] font-bold tracking-tight font-serif">Ari</span>
            </Link>

            {/* Desktop Links */}
            <div className="hidden lg:flex items-center gap-8">
              {navLinks.map((link) => {
                const dropdown = hasDropdown(link.label);

                if (dropdown) {
                  return (
                    <div
                      key={link.href}
                      className="relative"
                      onMouseEnter={() => handleMouseEnter(link.label)}
                      onMouseLeave={handleMouseLeave}
                    >
                      <Link
                        href={link.href}
                        className={`text-base font-medium font-display transition-colors duration-150 inline-flex items-center gap-1.5 ${
                          pathname === link.href || pathname.startsWith(link.href + "/")
                            ? "text-purple-brand"
                            : "text-black hover:text-purple-brand"
                        }`}
                      >
                        {link.icon}
                        {link.label}
                        <svg
                          className={`w-3 h-3 transition-transform duration-200 ${
                            openDropdown === link.label ? "rotate-180" : ""
                          }`}
                          viewBox="0 0 12 8"
                          fill="none"
                        >
                          <path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </Link>
                      {openDropdown === link.label && renderDropdown(link.label)}
                    </div>
                  );
                }

                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={`text-base font-medium font-display transition-colors duration-150 inline-flex items-center gap-1.5 ${
                      pathname === link.href ? "text-purple-brand" : "text-black hover:text-purple-brand"
                    }`}
                  >
                    {link.icon}
                    {link.label}
                  </Link>
                );
              })}
            </div>

            {/* CTAs */}
            <div className="hidden lg:flex items-center gap-3">
              {/* Try on WhatsApp — opens a chat with the Ari number so anyone
                  can start using it instantly, no signup. */}
              <a
                href="https://wa.me/19177958667?text=Hi%20Ari"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-base font-medium font-sans bg-[#25D366] text-black border-[1.6px] border-black rounded-[4px] px-5 py-1.5 shadow-brutal hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-brutal-hover active:translate-x-[4px] active:translate-y-[4px] active:shadow-none transition-all duration-150"
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor" aria-hidden="true">
                  <path d="M17.5 14.4c-.3-.2-1.7-.9-2-1-.3-.1-.5-.2-.6.2-.2.3-.7.9-.9 1.1-.2.2-.3.2-.6.1-.3-.2-1.2-.5-2.3-1.4-.9-.8-1.4-1.7-1.6-2-.2-.3 0-.5.1-.6.1-.1.3-.3.4-.5.2-.2.2-.3.3-.5.1-.2.1-.4 0-.5-.1-.2-.6-1.5-.9-2-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.5.1-.7.3-.3.3-.9.9-.9 2.2s.9 2.5 1.1 2.7c.1.2 1.8 2.8 4.4 3.9.6.3 1.1.4 1.5.5.6.2 1.2.2 1.6.1.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.2-.3-.2-.6-.4zM12 2a10 10 0 0 0-8.6 15l-1.3 4.8 4.9-1.3A10 10 0 1 0 12 2z" />
                </svg>
                Try on WhatsApp
              </a>
              {/* Open the local Ari desktop app. */}
              <a
                href="http://127.0.0.1:43101"
                className="inline-flex items-center text-base font-medium font-sans bg-white border-[1.6px] border-black rounded-[4px] px-6 py-1.5 shadow-brutal hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-brutal-hover active:translate-x-[4px] active:translate-y-[4px] active:shadow-none transition-all duration-150"
              >
                Open Ari Desktop
              </a>
            </div>

            {/* Mobile Toggle */}
            <button
              onClick={() => setMobileOpen(!mobileOpen)}
              className="lg:hidden w-10 h-10 border-[1.6px] border-black rounded-[4px] flex items-center justify-center shadow-brutal hover:translate-x-[1px] hover:translate-y-[1px] hover:shadow-brutal-hover active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-all duration-150 bg-white"
              aria-label="Toggle menu"
            >
              <div className="w-5 h-5 flex flex-col justify-center gap-1.5">
                <span className={`block h-[2px] w-5 bg-black transition-all duration-300 origin-center ${mobileOpen ? "rotate-45 translate-y-[5px]" : ""}`} />
                <span className={`block h-[2px] w-5 bg-black transition-all duration-300 origin-center ${mobileOpen ? "-rotate-45 -translate-y-[3px]" : ""}`} />
              </div>
            </button>
          </div>
        </div>

        {/* Mobile Menu */}
        <div className={`lg:hidden overflow-hidden transition-all duration-300 ${mobileOpen ? "max-h-[800px] border-t-2 border-black bg-white" : "max-h-0"}`}>
          <div className="max-w-7xl mx-auto px-6 py-4 space-y-0">
            <MobileDropdown
              label="Features"
              items={featureItems.map(({ label, href, desc }) => ({ label, href, desc }))}
              onClose={() => setMobileOpen(false)}
            />
            <Link href="/meet" onClick={() => setMobileOpen(false)} className={`block text-lg font-medium font-sans py-3 border-b border-black/10 ${pathname === "/meet" ? "text-purple-brand" : "text-black"}`}>
              Meet Bot
            </Link>
            <MobileDropdown
              label="About"
              items={aboutItems}
              onClose={() => setMobileOpen(false)}
            />
            <a
              href="https://wa.me/19177958667?text=Hi%20Ari"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 w-full text-center text-base font-medium font-sans bg-[#25D366] text-black border-[1.6px] border-black rounded-[4px] px-6 py-2 shadow-brutal hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-brutal-hover transition-all duration-150 mt-3"
              onClick={() => setMobileOpen(false)}
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor" aria-hidden="true">
                <path d="M17.5 14.4c-.3-.2-1.7-.9-2-1-.3-.1-.5-.2-.6.2-.2.3-.7.9-.9 1.1-.2.2-.3.2-.6.1-.3-.2-1.2-.5-2.3-1.4-.9-.8-1.4-1.7-1.6-2-.2-.3 0-.5.1-.6.1-.1.3-.3.4-.5.2-.2.2-.3.3-.5.1-.2.1-.4 0-.5-.1-.2-.6-1.5-.9-2-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.5.1-.7.3-.3.3-.9.9-.9 2.2s.9 2.5 1.1 2.7c.1.2 1.8 2.8 4.4 3.9.6.3 1.1.4 1.5.5.6.2 1.2.2 1.6.1.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.2-.3-.2-.6-.4zM12 2a10 10 0 0 0-8.6 15l-1.3 4.8 4.9-1.3A10 10 0 1 0 12 2z" />
              </svg>
              Try on WhatsApp · +1 (917) 795-8667
            </a>
            <a
              href="http://127.0.0.1:43101"
              className="block w-full text-center text-base font-medium font-sans bg-white border-[1.6px] border-black rounded-[4px] px-6 py-2 shadow-brutal hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-brutal-hover transition-all duration-150 mt-2"
              onClick={() => setMobileOpen(false)}
            >
              Open Ari Desktop
            </a>
          </div>
        </div>
      </nav>
    </>
  );
}
