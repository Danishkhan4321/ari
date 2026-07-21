import { redirect } from "next/navigation";
import { getCurrentUserPhone } from "@/lib/session";
import { Shell } from "@/components/shell";
import { CrmPage } from "@/components/crm-page";
import { GroupsList } from "./groups-list";

export const dynamic = "force-dynamic";

export default async function GroupsPage() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) redirect("/login");
  return (
    <Shell userPhone={userPhone} showHeader={false}>
      <CrmPage section="Manage groups" title="Groups" description="Create focused audiences and keep membership current before you send.">
        <GroupsList />
      </CrmPage>
    </Shell>
  );
}
