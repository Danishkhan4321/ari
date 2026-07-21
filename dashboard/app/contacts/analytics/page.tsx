import { redirect } from "next/navigation";
import { CrmPage } from "@/components/crm-page";
import { Shell } from "@/components/shell";
import { getCurrentUserPhone } from "@/lib/session";
import { CrmAnalytics } from "./crm-analytics";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) redirect("/login");
  return (
    <Shell userPhone={userPhone} showHeader={false}>
      <CrmPage section="Analytics" title="Analytics" description="Understand delivery quality and engagement across every campaign and recipient.">
        <CrmAnalytics />
      </CrmPage>
    </Shell>
  );
}
