import { redirect } from "next/navigation";
import { CrmPage } from "@/components/crm-page";
import { Shell } from "@/components/shell";
import { getCurrentUserPhone } from "@/lib/session";
import { EmailActivity } from "./email-activity";

export const dynamic = "force-dynamic";

export default async function EmailActivityPage() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) redirect("/login");
  return (
    <Shell userPhone={userPhone} showHeader={false}>
      <CrmPage section="Email activity" title="Email activity" description="Open any send to review the exact email, performance, and recipient-level outcomes.">
        <EmailActivity />
      </CrmPage>
    </Shell>
  );
}
