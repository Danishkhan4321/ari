import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUserPhone } from "@/lib/session";
import { Shell } from "@/components/shell";
import { EmailComposer } from "./composer";

export const dynamic = "force-dynamic";

export default async function EmailPage({ params }: { params: { id: string } }) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) redirect("/login");
  const id = Number(params.id);
  if (!Number.isInteger(id)) notFound();
  return <Shell userPhone={userPhone} showHeader={false}><div className="crm-page"><div className="crm-page-inner"><div className="crm-breadcrumb"><Link href="/contacts" className="hover:text-ari-ink">CRM</Link><span>/</span><Link href="/contacts/campaigns" className="hover:text-ari-ink">Campaigns</Link><span>/</span><span className="font-medium text-[#24211f]">Compose email</span></div><Link href={`/contacts/groups/${id}`} className="mt-4 inline-flex items-center gap-2 text-[11.5px] text-[#3c3834] hover:text-ari-ink"><span className="crm-icon-button h-7 w-7">‹</span> Go back</Link><div className="mt-5"><EmailComposer groupId={id} /></div></div></div></Shell>;
}
