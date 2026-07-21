"use client";

// One predictable CRM flow: people, audiences, sends, activity, results.
import Link from "next/link";
import { usePathname } from "next/navigation";

type Tab = { href: string; label: string; match: (p: string) => boolean };

const TABS: Tab[] = [
  {
    href: "/contacts",
    label: "Contacts",
    match: (p) =>
      p === "/contacts" || /^\/contacts\/\d+/.test(p),
  },
  { href: "/contacts/groups",    label: "Groups",    match: (p) => p.startsWith("/contacts/groups") },
  { href: "/contacts/campaigns", label: "Campaigns", match: (p) => p.startsWith("/contacts/campaigns") },
  { href: "/contacts/activity",  label: "Email activity", match: (p) => p.startsWith("/contacts/activity") },
  { href: "/contacts/analytics", label: "Analytics", match: (p) => p.startsWith("/contacts/analytics") },
];

export function CrmSubnav() {
  const pathname = usePathname() ?? "/contacts";
  return (
    <div className="mb-7 mt-7 overflow-x-auto border-b border-[#deddd8] [scrollbar-width:none]">
      <nav className="flex min-w-max gap-7" aria-label="CRM sections">
        {TABS.map((t) => {
          const active = t.match(pathname);
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? "page" : undefined}
              className={`relative h-9 whitespace-nowrap px-0 text-[12px] font-normal transition hover:text-ari-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ari-focus ${active ? "font-medium text-ari-ink after:absolute after:inset-x-0 after:bottom-[-1px] after:h-[2px] after:rounded-full after:bg-ari-accent" : "text-[#77736f]"}`}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
