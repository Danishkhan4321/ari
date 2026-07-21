"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AriMark } from "./icons";
import { WorkspaceToolNav } from "./workspace-tool-nav";

export function WorkspaceHeader({
  onOpenSearch,
  label = "Workspace",
  sidebarPresent = false,
}: {
  onOpenSearch?: () => void;
  label?: string;
  sidebarPresent?: boolean;
}) {
  const pathname = usePathname() || "/";
  const contextualLabel = label === "Workspace" ? getWorkspaceLabel(pathname) : label;

  return (
    <header className="flex h-14 shrink-0 items-center border-b border-ari-border bg-white">
      <Link href="/chat" className={`flex h-full w-[156px] shrink-0 items-center gap-2 px-3 ${sidebarPresent ? "md:hidden" : "md:w-[272px] md:border-r md:border-ari-border"}`}>
        <span className="grid h-7 w-7 place-items-center rounded-full bg-ari-ink">
          <AriMark className="h-5 w-5" />
        </span>
        <span className="text-[14px] font-semibold tracking-[-0.01em] text-ari-ink">Ari</span>
      </Link>

      <WorkspaceToolNav orientation="horizontal" className="flex-1 px-2 sm:px-4 md:hidden" />
      <div className="hidden min-w-0 flex-1 items-center px-6 md:flex">
        <span className="truncate text-[14px] font-medium tracking-[-0.015em] text-ari-ink">{contextualLabel}</span>
      </div>

      {onOpenSearch && (
        <div className="mr-4 flex shrink-0 items-center gap-2">
          <button
            type="button"
            aria-label="Notifications"
            className="grid h-8 w-8 place-items-center rounded-[7px] text-ari-muted transition hover:bg-ari-subtle hover:text-ari-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-focus"
          >
            <BellIcon />
          </button>
          <button
            type="button"
            onClick={onOpenSearch}
            aria-label="Search workspace"
            className="flex h-8 w-8 items-center gap-2 rounded-[7px] border border-ari-border bg-white px-2.5 text-ari-muted transition hover:bg-ari-subtle hover:text-ari-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-focus sm:w-[210px]"
          >
            <SearchIcon />
            <span className="hidden flex-1 text-left text-[11.5px] font-normal sm:block">Search</span>
            <span className="hidden text-[10px] font-medium text-ari-muted sm:block">⌘ K</span>
          </button>
        </div>
      )}
    </header>
  );
}

function getWorkspaceLabel(pathname: string): string {
  if (pathname.startsWith("/contacts") || pathname.startsWith("/crm")) return "Customer relationships";
  if (pathname.startsWith("/team")) return "Team";
  if (pathname.startsWith("/meetings")) return "Meetings";
  if (pathname.startsWith("/transcriptions")) return "Flowtype";
  if (pathname.startsWith("/tasks")) return "Personal workspace";
  if (pathname.startsWith("/settings")) return "Settings";
  if (pathname.startsWith("/inbox")) return "Scheduled emails";
  if (pathname.startsWith("/reminders")) return "Reminders";
  return "Home";
}

function BellIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.75 11.5h8.5l-1.1-1.55V6.8A3.16 3.16 0 0 0 8 3.6 3.16 3.16 0 0 0 4.85 6.8v3.15L3.75 11.5Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M6.7 12.5a1.35 1.35 0 0 0 2.6 0" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
