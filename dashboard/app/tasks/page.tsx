// dashboard/app/tasks/page.tsx — Tasks inside the Shell.
import { redirect } from "next/navigation";
import { getCurrentUserPhone } from "@/lib/session";
import { Shell } from "@/components/shell";
import { DashTopbar, DashPageBody } from "@/components/dash-page";
import { TasksContent } from "./tasks-content";

export const dynamic = "force-dynamic";

export default async function TasksPage() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) redirect("/login");
  return (
    <Shell userPhone={userPhone}>
      <DashTopbar title="my tasks" />
      <DashPageBody>
        <TasksContent />
      </DashPageBody>
    </Shell>
  );
}
