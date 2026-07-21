// dashboard/lib/format.ts
//
// Shared formatting helpers. Previously duplicated across 9 team
// section files (each defined its own fmtAgo, fmtDate, fmtTs). This
// keeps them consistent and shrinks the team bundle.

export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.round(months / 12);
  return `${years}y ago`;
}

// "12 May" or "12 May 2026" if year differs
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { day: "numeric", month: "short" }
    : { day: "numeric", month: "short", year: "numeric" });
}

// "Mon · 4:30pm"
export function fmtTs(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(undefined, {
    weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
  });
}

// "4:30pm"
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// "12 May → 18 May"
export function fmtRange(start: string, end: string | null | undefined): string {
  if (!end) return fmtDate(start);
  return `${fmtDate(start)} → ${fmtDate(end)}`;
}

// "₹500", "$50", "€42 EUR" for unknown symbols
export function fmtMoney(n: number, currency: string | null | undefined): string {
  const cur = (currency || "INR").toUpperCase();
  const sym = cur === "INR" ? "₹"
            : cur === "USD" ? "$"
            : cur === "EUR" ? "€"
            : cur === "GBP" ? "£"
            : "";
  const f = Math.abs(n) >= 1000
    ? n.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return sym ? `${sym}${f}` : `${f} ${cur}`;
}

// "12.5k", "1.2M" — compact for graph labels
export function fmtNumCompact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return Math.round(n).toLocaleString();
}

export function severityColor(s: string | null | undefined): string {
  const k = (s || "").toLowerCase();
  if (k === "critical") return "#ef4444";
  if (k === "high") return "#F59E0B";
  if (k === "medium") return "#8A65FF";
  return "#a3a3a3";
}
