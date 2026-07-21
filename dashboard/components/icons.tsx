// dashboard/components/icons.tsx
// Folk-style black line icons. 24×24 viewBox, stroke="currentColor",
// stroke-width 1.5, no fills. They inherit `color` from the parent so
// they look right against any bg without needing per-icon palette work.
//
// Sized via className (parent controls w-X h-X). Match Lucide/Feather
// proportions so they pair well with text at any size.
import * as React from "react";

type IconProps = { className?: string };
const cx = (a?: string) => a ?? "w-5 h-5";

const BASE_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function HomeIcon({ className }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={cx(className)}>
      <path d="M3 11l9-8 9 8" />
      <path d="M5 10v9a1 1 0 001 1h12a1 1 0 001-1v-9" />
      <path d="M10 20v-5h4v5" />
    </svg>
  );
}

export function ChatIcon({ className }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={cx(className)}>
      <path d="M21 11.5a8.4 8.4 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.4 8.4 0 01-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.4 8.4 0 013.8-.9h.5a8.5 8.5 0 018 8v.5z" />
    </svg>
  );
}

export function ReminderIcon({ className }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={cx(className)}>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2.5 2" />
      <path d="M9 2h6" />
      <path d="M5 5l2-2M19 5l-2-2" />
    </svg>
  );
}

export function TaskIcon({ className }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={cx(className)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l2 2 4-4" />
      <path d="M14 14h5" />
      <path d="M7 17h10" />
    </svg>
  );
}

export function ContactsIcon({ className }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={cx(className)}>
      <circle cx="9" cy="8" r="4" />
      <path d="M3 21v-1a6 6 0 016-6h0a6 6 0 016 6v1" />
      <circle cx="17" cy="9" r="3" />
      <path d="M21 19v-1a4 4 0 00-4-4" />
    </svg>
  );
}

/** CRM uses a contact record, keeping it visually distinct from the Team group. */
export function CrmIcon({ className }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={cx(className)}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <circle cx="9" cy="10" r="2.25" />
      <path d="M5.8 16c.7-1.8 1.8-2.7 3.2-2.7s2.5.9 3.2 2.7M15 9h3M15 13h3" />
    </svg>
  );
}

export function PipelineIcon({ className }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={cx(className)}>
      <rect x="3" y="4" width="5" height="16" rx="1" />
      <rect x="9.5" y="4" width="5" height="16" rx="1" />
      <rect x="16" y="4" width="5" height="16" rx="1" />
      <path d="M5 8h1M5 11h1" />
      <path d="M11.5 8h1M11.5 11h1M11.5 14h1" />
      <path d="M18 8h1" />
    </svg>
  );
}

export function InboxIcon({ className }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={cx(className)}>
      <path d="M22 12.5V6a2 2 0 00-2-2H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2v-1" />
      <path d="M2 7l10 6 10-6" />
    </svg>
  );
}

export function MessagesIcon({ className }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={cx(className)}>
      <path d="M4 4h12a2 2 0 012 2v7a2 2 0 01-2 2H9l-4 4v-4H4a2 2 0 01-2-2V6a2 2 0 012-2z" />
      <path d="M6 8h8M6 11h5" />
    </svg>
  );
}

export function MeetingIcon({ className }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={cx(className)}>
      <rect x="2" y="6" width="14" height="12" rx="2" />
      <path d="M16 10l6-3v10l-6-3z" />
      <circle cx="9" cy="12" r="2" />
    </svg>
  );
}

export function TeamIcon({ className }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={cx(className)}>
      <circle cx="9" cy="8" r="3.5" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M3 20v-1a6 6 0 016-6h0a6 6 0 016 6v1" />
      <path d="M21 19v-1a4 4 0 00-4-4" />
    </svg>
  );
}

export function NotesIcon({ className }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={cx(className)}>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 7h6M9 11h6M9 15h4" />
      <path d="M5 7h2M5 11h2M5 15h2" />
    </svg>
  );
}

/** Flowtype's voice-to-polished-text mark: a balanced waveform finished by a spark. */
export function FlowtypeIcon({ className }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={cx(className)} strokeWidth={1.65}>
      <path d="M4 13v-2M8 16V8M12 19V5M16 15V9" />
      <path d="M20 3.5v4M18 5.5h4" />
    </svg>
  );
}

export function ProductivityIcon({ className }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={cx(className)}>
      <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />
    </svg>
  );
}

export function SettingsIcon({ className }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={cx(className)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3h0a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8v0a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </svg>
  );
}

// KPI strip icons — same line style, slightly smaller stroke for the
// number-card context.
export function KpiClockIcon({ className }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={cx(className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
export function KpiBriefcaseIcon({ className }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={cx(className)}>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2" />
      <path d="M3 13h18" />
    </svg>
  );
}
export function KpiDollarIcon({ className }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={cx(className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 6v12" />
      <path d="M15 9h-4a2 2 0 000 4h2a2 2 0 010 4H9" />
    </svg>
  );
}
export function KpiChatIcon({ className }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={cx(className)}>
      <path d="M21 11.5a8.4 8.4 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.4 8.4 0 01-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.4 8.4 0 013.8-.9h.5a8.5 8.5 0 018 8v.5z" />
    </svg>
  );
}

// Brand mark — actual Ari logo PNG. Stays as-is.
export function AriMark({ className }: IconProps) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/ari-mark.svg"
      alt="Ari"
      className={cx(className)}
      draggable={false}
    />
  );
}

export function GroupsIcon({ className }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={cx(className)}>
      <rect x="3" y="4" width="8" height="7" rx="1.5" />
      <rect x="13" y="4" width="8" height="7" rx="1.5" />
      <rect x="3" y="13" width="8" height="7" rx="1.5" />
      <rect x="13" y="13" width="8" height="7" rx="1.5" />
    </svg>
  );
}
export function CampaignsIcon({ className }: IconProps) {
  return (
    <svg {...BASE_PROPS} className={cx(className)}>
      <path d="M3 11l18-7v16L3 13z" />
      <path d="M3 11v2" />
      <path d="M9 14v3a2 2 0 002 2h0a2 2 0 002-2v-1" />
    </svg>
  );
}

export type SectionKey =
  | "home" | "chat" | "reminders" | "tasks" | "contacts" | "pipeline"
  | "inbox" | "meetings" | "team" | "messages" | "notes" | "productivity" | "settings"
  | "groups" | "campaigns";

export function SectionIcon({ section, className }: { section: SectionKey; className?: string }) {
  switch (section) {
    case "home":         return <HomeIcon className={className} />;
    case "chat":         return <ChatIcon className={className} />;
    case "reminders":    return <ReminderIcon className={className} />;
    case "tasks":        return <TaskIcon className={className} />;
    case "contacts":     return <CrmIcon className={className} />;
    case "pipeline":     return <PipelineIcon className={className} />;
    case "inbox":        return <InboxIcon className={className} />;
    case "messages":     return <MessagesIcon className={className} />;
    case "meetings":     return <MeetingIcon className={className} />;
    case "team":         return <TeamIcon className={className} />;
    case "notes":        return <FlowtypeIcon className={className} />;
    case "productivity": return <ProductivityIcon className={className} />;
    case "settings":     return <SettingsIcon className={className} />;
    case "groups":       return <GroupsIcon className={className} />;
    case "campaigns":    return <CampaignsIcon className={className} />;
  }
}
