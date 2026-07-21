// dashboard/app/reminders/page.tsx — Reminders inside the Shell.
import { redirect } from "next/navigation";
import { getCurrentUserPhone } from "@/lib/session";
import { Shell } from "@/components/shell";
import { DashTopbar, DashPageBody } from "@/components/dash-page";
import { RemindersList } from "./reminders-list";

export const dynamic = "force-dynamic";

export default async function RemindersPage() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) redirect("/login");

  return (
    <Shell userPhone={userPhone}>
      <DashTopbar title="reminders" />
      <DashPageBody>
        <RemindersList />
      </DashPageBody>
    </Shell>
  );
}
