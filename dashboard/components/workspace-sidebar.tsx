"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SectionIcon, type SectionKey } from "./icons";
import { RecentChatsList, SidebarRecentChats, type RecentChatItem } from "./recent-chats";

type SidebarTool = { href: string; label: string; section: SectionKey };

const TOOLS: SidebarTool[] = [
  { href: "/chat", label: "Home", section: "chat" },
  { href: "/contacts", label: "CRM", section: "contacts" },
  { href: "/team", label: "Team", section: "team" },
  { href: "/meetings", label: "Meetings", section: "meetings" },
  { href: "/transcriptions", label: "Flowtype", section: "notes" },
  { href: "/tasks", label: "Personal workspace", section: "tasks" },
];

export function WorkspaceSidebar({
  expanded = true,
  onNewSession,
  sessions,
  onSelectSession,
  onRenameSession,
  userPhone,
}: {
  expanded?: boolean;
  onNewSession?: () => void;
  sessions?: RecentChatItem[];
  onSelectSession?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string) => void;
  userPhone?: string;
}) {
  const pathname = usePathname() || "/";
  const isActive = (href: string) => {
    if (href === "/contacts") return pathname.startsWith("/contacts") || pathname.startsWith("/crm");
    return pathname === href || pathname.startsWith(`${href}/`);
  };
  const newSessionClass = `flex h-11 w-full items-center rounded-[9px] border border-[#e0c821] bg-[#fff8c8] text-[13px] font-medium text-ari-ink shadow-[0_1px_3px_rgba(38,8,5,0.04)] transition hover:border-[#dec51f] hover:bg-[#fff4ad] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-focus ${expanded ? "gap-2.5 px-3.5" : "justify-center"}`;

  return (
    <aside className={`ari-home-rail relative hidden shrink-0 flex-col rounded-[16px] border border-[#e7e2d5] bg-ari-nav py-[18px] shadow-[0_1px_2px_rgba(38,8,5,0.025)] transition-[width] duration-200 md:flex ${expanded ? "w-[264px]" : "w-[60px]"}`} aria-label="Workspace navigation">
      <div className="px-[17px]">
        {onNewSession ? (
          <button type="button" onClick={onNewSession} title="New session" className={newSessionClass}>
            <ComposeIcon />{expanded && <span>New session</span>}
          </button>
        ) : (
          <Link href="/chat" title="New session" className={newSessionClass}>
            <ComposeIcon />{expanded && <span>New session</span>}
          </Link>
        )}
      </div>

      <nav className="mt-3.5 space-y-1 px-2.5" aria-label="Workspace tools">
        {TOOLS.map((tool) => {
          const active = isActive(tool.href);
          return (
            <Link
              key={tool.href}
              href={tool.href}
              title={tool.label}
              aria-label={tool.label}
              aria-current={active ? "page" : undefined}
              className={`flex h-9 items-center rounded-[8px] text-[#171717] transition hover:bg-[#f8f3da] hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-focus ${expanded ? "gap-3 px-3" : "justify-center"} ${active ? "bg-ari-nav-active text-black" : ""}`}
            >
              <SectionIcon section={tool.section} className="h-4 w-4 shrink-0" />
              {expanded && <span className={`truncate text-[13px] tracking-[-0.01em] ${active ? "font-medium" : "font-normal"}`}>{tool.label}</span>}
            </Link>
          );
        })}
      </nav>

      {expanded && (
        <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-3">
          {sessions ? (
            <RecentChatsList items={sessions} onSelect={onSelectSession} onRename={onRenameSession} />
          ) : (
            <SidebarRecentChats />
          )}
        </div>
      )}

      <div className={`relative mt-auto border-t border-[#e7e2d5] px-3 pt-3 ${expanded ? "" : "flex flex-col items-center"}`}>
        <details className="group relative w-full">
          <summary
          aria-label="Open profile menu"
          aria-haspopup="menu"
          title={expanded ? undefined : "Profile"}
            className={`flex min-h-12 w-full cursor-pointer list-none items-center rounded-[9px] text-left transition hover:bg-ari-nav-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-focus [&::-webkit-details-marker]:hidden ${expanded ? "gap-2.5 px-2" : "justify-center"}`}
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ari-ink text-[11px] font-medium text-white">A</span>
            {expanded && (
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium text-ari-ink">Personal workspace</span>
                <span className="mt-0.5 block text-[10px] font-normal text-ari-muted">{userPhone ? maskAccount(userPhone) : "Professional"}</span>
              </span>
            )}
            {expanded && <ProfileChevron />}
          </summary>
          <div role="menu" aria-label="Profile menu" className={`absolute bottom-[58px] z-40 rounded-[10px] border border-ari-border bg-white p-1.5 shadow-[0_14px_34px_rgba(38,8,5,0.12)] ${expanded ? "inset-x-0" : "left-0 w-[190px]"}`}>
            <Link href="/settings" role="menuitem" className="flex h-9 items-center gap-2.5 rounded-[7px] px-2.5 text-[12px] font-medium text-ari-text transition hover:bg-ari-nav-active hover:text-ari-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-focus">
              <SettingsIcon />
              <span>Settings</span>
            </Link>
          </div>
        </details>
      </div>

    </aside>
  );
}

function ComposeIcon() {
  return <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 11.5V13h1.5L12.8 4.7 11.3 3.2 3 11.5Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><path d="m10.5 4 1.5 1.5" stroke="currentColor" strokeWidth="1.4" /></svg>;
}

function SettingsIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.3" /><path d="M8 2.25v1.2M8 12.55v1.2M13.75 8h-1.2M3.45 8h-1.2M12.07 3.93l-.85.85M4.78 11.22l-.85.85M12.07 12.07l-.85-.85M4.78 4.78l-.85-.85" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>;
}

function ProfileChevron() {
  return <svg className="h-3 w-3 shrink-0 text-ari-muted transition-transform group-open:rotate-180" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function maskAccount(value: string) {
  const clean = value.replace(/\s/g, "");
  return clean.length <= 5 ? clean : `${clean.slice(0, 3)}••••${clean.slice(-3)}`;
}
