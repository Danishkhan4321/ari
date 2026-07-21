// dashboard/app/contacts/pipeline/page.tsx — Sales pipeline kanban.
import { redirect } from "next/navigation";
import { getCurrentUserPhone } from "@/lib/session";
import { Shell } from "@/components/shell";
import { DashTopbar, DashPageBody, PageHead } from "@/components/dash-page";
import { CrmSubnav } from "@/components/crm-subnav";
import { PipelineBoard } from "./pipeline-board";

export const dynamic = "force-dynamic";

export default async function PipelinePage() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) redirect("/login");

  return (
    <Shell userPhone={userPhone}>
      <DashTopbar title="pipeline" />
      <div className="px-6 lg:px-12 py-12 lg:py-14 max-w-[1600px]">
        <PageHead
          title="Pipeline"
          subtitle="Drag a card between columns to update its stage."
          badge={{ label: "CRM · Sales", color: "#D8CCFF" }}
        />
        <CrmSubnav />
        <PipelineBoard />
      </div>
    </Shell>
  );
}
