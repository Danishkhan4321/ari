import { redirect } from "next/navigation";
import { getCurrentUserPhone } from "@/lib/session";
import { Shell } from "@/components/shell";
import { DashTopbar, DashPageBody, PageHead } from "@/components/dash-page";
import { SettingsContent } from "./settings-content";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) redirect("/login");
  return (
    <Shell userPhone={userPhone}>
      <DashTopbar title="settings" />
      <DashPageBody>
        <PageHead
          title="Settings"
          subtitle="Account, integrations, and AI preferences."
          badge={{ label: "Account", color: "#a3a3a3" }}
        />
        <SettingsContent />
      </DashPageBody>
    </Shell>
  );
}
