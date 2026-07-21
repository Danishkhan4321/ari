"use client";

// Demo-style page primitives — DashTopbar, PageHead, Tabs, StatusPill,
// EmptyState. Adapted for Ari's dashboard so
// every section page in the real dashboard reads visually identical.
//
// Usage pattern per page:
//   export default function FooPage() {
//     return (
//       <Shell userPhone={userPhone}>
//         <DashTopbar title="reminders" actions={<...>} />
//         <DashPageBody>
//           <PageHead title="Reminders" subtitle="…" badge={{label, color}} actions={...} />
//           …content (dash-card / dash-card-hero) …
//         </DashPageBody>
//       </Shell>
//     );
//   }
import { ReactNode } from "react";

/* ───────── Topbar ───────── */
// Sticky top bar that sits above every section page, mirroring the demo.
// "title" is just a hint for the search-input placeholder.
export function DashTopbar({ title, actions }: { title?: string; actions?: ReactNode }) {
  if (!actions) return null;
  return (
    <div className="flex items-center justify-end border-b border-ari-border bg-white px-6 py-3 lg:px-9" aria-label={title || "Page actions"}>
      <div className="flex items-center gap-2">{actions}</div>
    </div>
  );
}

/* ───────── Page body wrapper ───────── */
// Standard padding + max-width for every section page so spacing stays
// uniform.
export function DashPageBody({ children }: { children: ReactNode }) {
  return (
    <div className="w-full min-w-0 max-w-[1180px] mx-auto px-5 py-8 sm:px-7 lg:px-9 lg:py-9">
      {children}
    </div>
  );
}

/* ───────── Page head (eyebrow + title + subtitle + actions) ───────── */
export function PageHead({
  title,
  subtitle,
  badge,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  badge?: { label: string; color: string };
  actions?: ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-5">
      <div className="min-w-0">
        {badge && (
          <div className="dash-label mb-2.5 flex items-center gap-2">
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{ background: badge.color }}
            />
            {badge.label}
          </div>
        )}
        <h1 className="dash-h1 text-[25px]">{title}</h1>
        {subtitle && (
          <p className="mt-2 max-w-2xl text-[12.5px] font-normal leading-relaxed text-ari-muted">
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  );
}

/* ───────── Tabs ───────── */
// Pill-style tabs identical to the demo's Tabs component.
export function Tabs<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex gap-0.5 rounded-lg border border-ari-border bg-white p-1">
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
                value === o.value ? "text-ari-muted" : "text-ari-muted"
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

/* ───────── Status pill ───────── */
export function StatusPill({
  color,
  children,
}: {
  color: string;
  children: ReactNode;
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

/* ───────── Empty state ───────── */
export function EmptyState({
  icon,
  title,
  body,
  cta,
}: {
  icon: ReactNode;
  title: string;
  body: ReactNode;
  cta?: ReactNode;
}) {
  return (
    <div className="dash-card p-10 text-center">
      <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-ari-border bg-ari-nav-active text-ari-ink">
        {icon}
      </div>
      <div className="dash-h2 text-[14px]">{title}</div>
      <p className="mx-auto mt-2 max-w-sm text-[12px] font-normal leading-relaxed text-ari-muted">
        {body}
      </p>
      {cta && <div className="mt-5">{cta}</div>}
    </div>
  );
}

/* ───────── Inline footer (used by section pages) ───────── */
export function PageFooter({ children }: { children?: ReactNode }) {
  return (
    <div className="mt-14 pb-10 flex items-center justify-between text-[11px] text-[#a3a3a3]">
      <div>© Ari 2026</div>
      <div className="flex items-center gap-4">{children}</div>
    </div>
  );
}
