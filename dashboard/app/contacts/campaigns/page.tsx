import { redirect } from "next/navigation";
import { getCurrentUserPhone } from "@/lib/session";
import { Shell } from "@/components/shell";
import { CrmPage } from "@/components/crm-page";
import { CampaignsList } from "./campaigns-list";

export const dynamic = "force-dynamic";

export default async function CampaignsPage() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) redirect("/login");
  return (
    <Shell userPhone={userPhone} showHeader={false}>
      <CrmPage section="Manage campaigns" title="Campaigns" description="Compose, schedule, pace, and track every group email from one workspace.">
        <CampaignsList />
      </CrmPage>
    </Shell>
  );
}
