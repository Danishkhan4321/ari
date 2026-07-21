"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/preview-nudge/dashboard/contacts", label: "All contacts", count: 184 },
  { href: "/preview-nudge/dashboard/contacts/pipeline", label: "Pipeline", count: 12 },
  { href: "/preview-nudge/dashboard/contacts/groups", label: "Groups", count: 8 },
  { href: "/preview-nudge/dashboard/contacts/campaigns", label: "Campaigns", count: 3 },
];

export function CrmSubnav() {
  const pathname = usePathname();
  return (
    <div className="flex items-center gap-1 mb-6 border-b border-[#e8e6dc]">
      {items.map((it) => {
        const active =
          it.href === "/preview-nudge/dashboard/contacts"
            ? pathname === it.href
            : pathname?.startsWith(it.href);
        return (
          <Link
            key={it.href}
            href={it.href}
            className={`relative px-4 py-3 text-[13px] font-medium transition-colors ${
              active
                ? "text-[#0a0a0a]"
                : "text-[#737373] hover:text-[#0a0a0a]"
            }`}
          >
            {it.label}
            <span
              className={`ml-1.5 num text-[11px] ${
                active ? "text-[#0a0a0a] font-semibold" : "text-[#a3a3a3]"
              }`}
            >
              {it.count}
            </span>
            {active && (
              <span className="absolute left-3 right-3 -bottom-px h-[2px] bg-[#0a0a0a]" />
            )}
          </Link>
        );
      })}
    </div>
  );
}
