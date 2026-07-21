"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { SectionIcon, type SectionKey } from "./icons";

type WorkspaceTool = { label: string; href: string; section: SectionKey };

export const PRIMARY_TOOLS: WorkspaceTool[] = [
  { label: "Home", href: "/chat", section: "chat" },
  { label: "CRM", href: "/contacts", section: "contacts" },
  { label: "Team", href: "/team", section: "team" },
  { label: "Meetings", href: "/meetings", section: "meetings" },
];

export const PERSONAL_TOOLS: WorkspaceTool[] = [
  { label: "Tasks", href: "/tasks", section: "tasks" },
  { label: "Reminders", href: "/reminders", section: "reminders" },
  { label: "Scheduled emails", href: "/inbox", section: "inbox" },
];

export const WORKSPACE_TOOLS = [...PRIMARY_TOOLS, ...PERSONAL_TOOLS];

export function WorkspaceToolNav({
  orientation = "vertical",
  className = "",
}: {
  orientation?: "vertical" | "horizontal";
  className?: string;
}) {
  const pathname = usePathname() || "/";
  const isActive = (href: string) => {
    if (href === "/contacts") return pathname.startsWith("/contacts") || pathname.startsWith("/crm");
    return pathname === href || pathname.startsWith(`${href}/`);
  };
  const personalActive = PERSONAL_TOOLS.some((tool) => isActive(tool.href));
  const [personalOpen, setPersonalOpen] = useState(personalActive);
  const [mobilePersonalOpen, setMobilePersonalOpen] = useState(false);
  const vertical = orientation === "vertical";

  useEffect(() => {
    if (personalActive) setPersonalOpen(true);
    setMobilePersonalOpen(false);
  }, [pathname, personalActive]);

  if (!vertical) {
    return (
      <nav
        aria-label="Workspace tools"
        data-orientation={orientation}
        className={`flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] ${className}`}
      >
        {PRIMARY_TOOLS.map((tool) => (
          <ToolLink key={tool.href} tool={tool} active={isActive(tool.href)} />
        ))}
        <button
          type="button"
          aria-expanded={mobilePersonalOpen}
          aria-controls="mobile-personal-workspace-menu"
          onClick={() => setMobilePersonalOpen((open) => !open)}
          className={`flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-lavender ${
            personalActive ? "border border-ari-border bg-white text-ari-text shadow-[0_2px_8px_rgba(45,37,55,0.05)]" : "text-[#625b69] hover:bg-white hover:text-ari-text"
          }`}
        >
          <SectionIcon section="home" className="h-3.5 w-3.5" />
          <span>Personal</span>
          <ChevronIcon open={mobilePersonalOpen} />
        </button>
        {mobilePersonalOpen && (
          <>
            <button
              type="button"
              aria-label="Close personal workspace menu"
              className="fixed inset-0 z-40 cursor-default bg-transparent"
              onClick={() => setMobilePersonalOpen(false)}
            />
            <div id="mobile-personal-workspace-menu" className="fixed inset-x-3 top-14 z-50 rounded-xl border border-ari-border bg-white p-2 shadow-[0_16px_40px_rgba(42,30,60,0.16)]">
              <div className="px-2 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-ari-muted">Personal workspace</div>
              <div className="space-y-px">
                {PERSONAL_TOOLS.map((tool) => (
                  <ToolLink key={tool.href} tool={tool} active={isActive(tool.href)} vertical />
                ))}
              </div>
            </div>
          </>
        )}
      </nav>
    );
  }

  return (
    <nav
      aria-label="Workspace tools"
      data-orientation={orientation}
      className={`space-y-px ${className}`}
    >
      {PRIMARY_TOOLS.map((tool) => (
        <ToolLink key={tool.href} tool={tool} active={isActive(tool.href)} vertical />
      ))}

      <div className="pt-px" data-group="personal-workspace">
        <button
          type="button"
          aria-expanded={personalOpen}
          aria-controls="personal-workspace-tools"
          onClick={() => setPersonalOpen((open) => !open)}
          className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-lavender ${
            personalActive ? "border border-ari-border bg-white text-ari-text shadow-[0_2px_8px_rgba(45,37,55,0.05)]" : "text-[#625b69] hover:bg-white hover:text-ari-text"
          }`}
        >
          <SectionIcon section="home" className="h-3.5 w-3.5" />
          <span className="min-w-0 flex-1 truncate text-left">Personal workspace</span>
          <ChevronIcon open={personalOpen} />
        </button>

        {personalOpen && (
          <div id="personal-workspace-tools" className="ml-3 mt-px space-y-px border-l border-ari-border pl-1">
            {PERSONAL_TOOLS.map((tool) => (
              <ToolLink key={tool.href} tool={tool} active={isActive(tool.href)} vertical nested />
            ))}
          </div>
        )}
      </div>
    </nav>
  );
}

function ToolLink({
  tool,
  active,
  vertical = false,
  nested = false,
}: {
  tool: WorkspaceTool;
  active: boolean;
  vertical?: boolean;
  nested?: boolean;
}) {
  return (
    <Link
      href={tool.href}
      aria-current={active ? "page" : undefined}
      className={`relative flex shrink-0 items-center font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-lavender ${
        vertical
          ? `h-8 w-full gap-2 rounded-md text-[13px] ${nested ? "px-2 text-[12.5px]" : "px-2"} ${
              active ? "border border-ari-border bg-white text-ari-text shadow-[0_2px_8px_rgba(45,37,55,0.05)]" : "text-[#625b69] hover:bg-white hover:text-ari-text"
            }`
          : `h-8 gap-1.5 rounded-md px-2 text-[12px] ${
              active ? "border border-ari-border bg-white text-ari-text shadow-[0_2px_8px_rgba(45,37,55,0.05)]" : "text-[#625b69] hover:bg-white hover:text-ari-text"
            }`
      }`}
    >
      <SectionIcon section={tool.section} className="h-3.5 w-3.5" />
      <span className="truncate">{tool.label}</span>
    </Link>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
