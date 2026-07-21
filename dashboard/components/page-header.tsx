// Standard page header. Removes the inconsistency between section pages
// (some had a back-link, some had a CTA, some had subtitle, etc.).
//
// Example:
//   <PageHeader
//     icon={<ReminderIcon className="w-9 h-9" />}
//     title="Reminders"
//     subtitle="Snooze, mark done, or cancel."
//     actions={<a href="/contacts/pipeline" className="btn-brutal-sm bg-card-lime">View pipeline →</a>}
//   />
import * as React from "react";

export function PageHeader({
  icon, title, subtitle, actions,
}: {
  icon?: React.ReactNode;
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="mb-8 flex items-end justify-between gap-4 flex-wrap">
      <div className="min-w-0">
        <h1 className="text-[32px] lg:text-[36px] font-bold leading-tight tracking-tight flex items-center gap-3">
          {icon}
          {title}
        </h1>
        {subtitle && (
          <p className="text-txt-muted mt-1.5 max-w-2xl text-[15px]">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
    </header>
  );
}

// Section heading (within a page, smaller than PageHeader)
export function SectionHeading({
  title, count, action,
}: { title: string; count?: number; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-lg font-bold flex items-center gap-2">
        {title}
        {typeof count === "number" && (
          <span className="text-txt-muted font-normal text-base">({count})</span>
        )}
      </h2>
      {action}
    </div>
  );
}
