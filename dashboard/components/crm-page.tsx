import Link from "next/link";
import type { ReactNode } from "react";
import { CrmSubnav } from "./crm-subnav";

export function CrmPage({
  section,
  title,
  description,
  actions,
  children,
}: {
  section: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="crm-page">
      <div className="crm-page-inner">
        <div className="crm-breadcrumb">
          <Link href="/contacts" className="hover:text-ari-ink">CRM</Link>
          <span aria-hidden="true">/</span>
          <span className="font-medium text-[#24211f]">{section}</span>
        </div>

        <div className="mt-4 flex flex-wrap items-end justify-between gap-5">
          <div className="min-w-0">
            <h1 className="crm-page-title">{title}</h1>
            {description ? <p className="crm-page-copy">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>

        <CrmSubnav />
        {children}
      </div>
    </div>
  );
}

export function CrmState({
  title,
  description,
  action,
  tone = "neutral",
}: {
  title: string;
  description: string;
  action?: ReactNode;
  tone?: "neutral" | "error";
}) {
  return (
    <div className={`crm-panel flex min-h-[230px] flex-col items-center justify-center px-6 py-12 text-center ${tone === "error" ? "border-[#e9caca] bg-[#fffafa]" : ""}`}>
      <div className={`mb-4 grid h-9 w-9 place-items-center rounded-full border text-[15px] ${tone === "error" ? "border-[#e9caca] text-[#a32424]" : "border-[#e5dda3] bg-ari-nav text-ari-ink"}`} aria-hidden="true">
        {tone === "error" ? "!" : "+"}
      </div>
      <h2 className="text-[13px] font-semibold text-[#24211f]">{title}</h2>
      <p className="mt-1.5 max-w-md text-[11.5px] leading-[1.6] text-[#77736f]">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function CrmLoading({ rows = 6 }: { rows?: number }) {
  return (
    <div className="crm-panel" role="status" aria-label="Loading">
      <div className="h-12 animate-pulse border-b border-[#e5e3df] bg-[#faf9f5]" />
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex h-[55px] items-center gap-5 border-b border-[#eceae6] px-4 last:border-b-0">
          <span className="h-3 w-32 animate-pulse rounded bg-[#eeece7]" />
          <span className="h-3 w-24 animate-pulse rounded bg-[#f2f0eb]" />
          <span className="h-3 w-20 animate-pulse rounded bg-[#f2f0eb]" />
        </div>
      ))}
    </div>
  );
}

export function CrmPagination({
  page,
  pageCount,
  total,
  onPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#e5e3df] px-4 py-3 text-[10.5px] text-[#77736f]">
      <span>{total.toLocaleString()} total</span>
      <div className="flex items-center gap-2">
        <button className="crm-button min-h-8 px-2.5" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
        <span className="min-w-[70px] text-center">Page {page} of {Math.max(1, pageCount)}</span>
        <button className="crm-button min-h-8 px-2.5" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}

export function CrmToast({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="crm-toast" role="status">
      <span aria-hidden="true">✓</span>
      <span className="flex-1">{message}</span>
      <button onClick={onClose} className="text-[#77736f] hover:text-[#24211f]" aria-label="Dismiss notification">×</button>
    </div>
  );
}

export function CrmConfirm({
  title,
  description,
  confirmLabel,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <div className="crm-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="crm-confirm-title" onMouseDown={onClose}>
      <div className="crm-modal max-w-[430px]" onMouseDown={(event) => event.stopPropagation()}>
        <div className="border-b border-[#e5e3df] px-5 py-4">
          <h2 id="crm-confirm-title" className="text-[14px] font-semibold tracking-[-0.02em] text-[#24211f]">{title}</h2>
          <p className="mt-1.5 text-[11.5px] leading-[1.6] text-[#77736f]">{description}</p>
        </div>
        <div className="flex justify-end gap-2 px-5 py-4">
          <button className="crm-button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="crm-button crm-button-danger" onClick={onConfirm} disabled={busy}>{busy ? "Working…" : confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
