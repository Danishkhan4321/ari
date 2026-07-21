import { redirect } from "next/navigation";
import { getCurrentUserPhone } from "@/lib/session";
import { Shell } from "@/components/shell";
import { MeetingsContent } from "./meetings-content";

export const dynamic = "force-dynamic";

export default async function MeetingsPage() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) redirect("/login");
  return (
    <Shell userPhone={userPhone} showHeader={false}>
      <main className="crm-page">
        <div className="crm-page-inner">
          <div>
            <h1 className="crm-page-title">Meetings</h1>
            <p className="crm-page-copy">Record the conversation. Ari handles everything after.</p>
          </div>
          <MeetingsContent />
        </div>
      </main>
    </Shell>
  );
}
