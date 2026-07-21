// Standard empty state. Replaces ad-hoc empty divs scattered through
// the section components. One consistent pattern: large icon, title,
// body, optional CTA.
import * as React from "react";

export function EmptyState({
  icon, title, body, cta,
}: {
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
  cta?: React.ReactNode;
}) {
  return (
    <div className="card-brutal rounded-[4px] p-10 text-center">
      <div className="mx-auto mb-4 flex items-center justify-center">{icon}</div>
      <div className="font-bold text-lg mb-1">{title}</div>
      <div className="text-txt-muted text-sm max-w-md mx-auto">{body}</div>
      {cta && <div className="mt-5">{cta}</div>}
    </div>
  );
}
