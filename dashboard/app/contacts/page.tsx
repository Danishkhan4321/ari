import { redirect } from "next/navigation";
import { getCurrentUserPhone } from "@/lib/session";
import { Shell } from "@/components/shell";
import { CrmPage } from "@/components/crm-page";
import { ContactsContent } from "./contacts-content";

export const dynamic = "force-dynamic";

export default async function ContactsPage() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) redirect("/login");
  return (
    <Shell userPhone={userPhone} showHeader={false}>
      <CrmPage section="Manage contacts" title="Contacts" description="Keep customer records clean, searchable, grouped, and ready for outreach.">
        <ContactsContent />
      </CrmPage>
    </Shell>
  );
}
