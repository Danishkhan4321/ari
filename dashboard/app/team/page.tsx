import { redirect } from "next/navigation";
import { getCurrentUserPhone } from "@/lib/session";
import { Shell } from "@/components/shell";
import { TeamContent } from "./team-content";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) redirect("/login");

  return (
    <Shell userPhone={userPhone} showHeader={false}>
      <main className="crm-page team-page">
        <div className="crm-page-inner">
          <div className="crm-breadcrumb">
            <span>Team</span>
            <span aria-hidden="true">/</span>
            <span className="font-medium text-[#24211f]">Workspace</span>
          </div>

          <div className="mt-4">
            <h1 className="crm-page-title">Team workspace</h1>
            <p className="crm-page-copy">Coordinate people, daily work, communication, and team operations in one place.</p>
          </div>

          <TeamContent userPhone={userPhone} />
        </div>
      </main>
    </Shell>
  );
}
