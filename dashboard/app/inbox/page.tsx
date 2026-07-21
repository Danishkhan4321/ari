import { redirect } from "next/navigation";
import { getCurrentUserPhone } from "@/lib/session";
import { Shell } from "@/components/shell";
import { DashTopbar, DashPageBody, PageHead } from "@/components/dash-page";
import { InboxContent } from "./inbox-content";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) redirect("/login");
  return (
    <Shell userPhone={userPhone}>
      <DashTopbar title="scheduled emails" />
      <DashPageBody>
        <PageHead
          title="Scheduled emails"
          subtitle="Scheduled emails waiting to send. Cancel anything that hasn't fired yet."
          badge={{ label: "Outbound queue", color: "#FFB1D8" }}
        />
        <InboxContent />
      </DashPageBody>
    </Shell>
  );
}
