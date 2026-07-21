// dashboard/app/crm/page.tsx — CRM section (Phase 4).
// Server component: auth-gates, loads the user's leads + contacts from the
// SAME tables the bot writes (sales_leads, contacts), then hands them to the
// client component for the interactive pipeline board.
import { redirect } from "next/navigation";
import { getCurrentUserPhone } from "@/lib/session";
import { getLeads, getContacts, computeStats } from "@/lib/crm";
import CrmClient from "./crm-client";

export const dynamic = "force-dynamic";

export default async function CrmPage() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) redirect("/login");
  redirect("/contacts");

  const [leads, contacts] = await Promise.all([
    getLeads(userPhone!),
    getContacts(userPhone!),
  ]);
  const stats = computeStats(leads);

  return (
    <main className="min-h-screen p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <header className="mb-8 flex items-center justify-between flex-wrap gap-4">
          <div>
            <div className="flex items-center gap-3">
              <a href="/" className="text-txt-muted hover:text-black text-sm">← Dashboard</a>
            </div>
            <h1 className="text-3xl md:text-4xl font-bold mt-1">CRM</h1>
            <p className="text-txt-muted mt-1">
              {stats.totalLeads} lead{stats.totalLeads !== 1 ? "s" : ""} · {contacts.length} contact{contacts.length !== 1 ? "s" : ""}
            </p>
          </div>
          <form action="/api/auth/logout" method="POST">
            <button type="submit" className="btn-brutal-sm bg-card">Sign out</button>
          </form>
        </header>

        {/* Headline numbers */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <div className="card-brutal rounded-[4px] p-4">
            <div className="text-sm text-txt-muted">Total leads</div>
            <div className="text-2xl font-bold">{stats.totalLeads}</div>
          </div>
          <div className="card-brutal rounded-[4px] p-4 bg-card-lime">
            <div className="text-sm text-txt-muted">Open pipeline</div>
            <div className="text-2xl font-bold">{formatMoney(stats.openValue)}</div>
          </div>
          <div className="card-brutal rounded-[4px] p-4 bg-card-lemon">
            <div className="text-sm text-txt-muted">Won</div>
            <div className="text-2xl font-bold">{formatMoney(stats.wonValue)}</div>
          </div>
          <div className="card-brutal rounded-[4px] p-4">
            <div className="text-sm text-txt-muted">Contacts</div>
            <div className="text-2xl font-bold">{contacts.length}</div>
          </div>
        </div>

        <CrmClient initialLeads={leads} contacts={contacts} />
      </div>
    </main>
  );
}

function formatMoney(n: number): string {
  if (!n) return "—";
  // Compact ₹ formatting; the bot stores deal_value as plain NUMERIC.
  if (n >= 1_00_00_000) return `₹${(n / 1_00_00_000).toFixed(1)}Cr`;
  if (n >= 1_00_000) return `₹${(n / 1_00_000).toFixed(1)}L`;
  if (n >= 1_000) return `₹${(n / 1_000).toFixed(0)}k`;
  return `₹${n}`;
}
