// dashboard/app/page.tsx — home (Folk-style minimal).
import { redirect } from "next/navigation";
import { getCurrentUserPhone } from "@/lib/session";
import { Shell } from "@/components/shell";
import { KpiStrip } from "@/components/kpi-strip";
import { SectionIcon, type SectionKey } from "@/components/icons";

export const dynamic = "force-dynamic";

export default async function Home() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) redirect("/login");

  return (
    <Shell userPhone={userPhone}>
      <div className="w-full min-w-0 px-6 lg:px-12 py-10 lg:py-14 max-w-6xl">
        <header className="mb-10">
          <h1 className="font-serif text-[44px] lg:text-[52px] font-normal leading-[1.05] tracking-tight">
            Welcome back.
          </h1>
          <p className="text-txt-muted mt-2 text-[16px]">Here&apos;s the pulse of your day.</p>
        </header>

        <KpiStrip />

        <h2 className="mt-14 mb-5 text-[11px] uppercase tracking-[0.18em] font-bold text-txt-muted">Sections</h2>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3 min-w-0">
          {SECTIONS.map((s) => (
            <a
              key={s.title}
              href={s.href}
              className="card-soft p-5 transition-all duration-150 hover:-translate-y-0.5 hover:shadow-[0_2px_4px_rgba(0,0,0,0.06),0_8px_20px_rgba(0,0,0,0.06)]"
            >
              <SectionIcon section={s.section} className="w-6 h-6 mb-4" />
              <div className="font-semibold text-[15px]">{s.title}</div>
              <div className="text-[13px] text-txt-muted mt-0.5 leading-snug">{s.note}</div>
            </a>
          ))}
        </div>
      </div>
    </Shell>
  );
}

const SECTIONS: { section: SectionKey; title: string; note: string; href: string }[] = [
  { section: "chat",         title: "Home",            note: "Ask Ari to coordinate your work", href: "/chat" },
  { section: "reminders",    title: "Reminders",       note: "Snooze, mark done, cancel",          href: "/reminders" },
  { section: "tasks",        title: "Tasks",           note: "Mine, assigned, delegated",          href: "/tasks" },
  { section: "contacts",     title: "Contacts & CRM",  note: "Pipeline, leads, activity timeline", href: "/contacts" },
  { section: "inbox",        title: "Inbox",           note: "Scheduled emails",                   href: "/inbox" },
  { section: "meetings",     title: "Meetings",        note: "Recordings, transcripts, summaries", href: "/meetings" },
  { section: "team",         title: "Team",            note: "Members, standups, polls, leave",    href: "/team" },
  { section: "settings",     title: "Settings",        note: "Account, integrations, AI",          href: "/settings" },
];
