import { notFound, redirect } from "next/navigation";
import { getCurrentUserPhone } from "@/lib/session";
import { Shell } from "@/components/shell";
import { LeadDetail } from "./lead-detail";

export const dynamic = "force-dynamic";

export default async function LeadDetailPage({ params }: { params: { id: string } }) {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) redirect("/login");
  const id = Number(params.id);
  if (!Number.isInteger(id)) notFound();
  return <Shell userPhone={userPhone} showHeader={false}><LeadDetail id={id} /></Shell>;
}
