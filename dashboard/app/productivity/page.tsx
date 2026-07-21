import { redirect } from "next/navigation";
import { getCurrentUserPhone } from "@/lib/session";
import { Shell } from "@/components/shell";
import { DashTopbar, DashPageBody, PageHead } from "@/components/dash-page";
import { ProductivityContent } from "./productivity-content";

export const dynamic = "force-dynamic";

export default async function ProductivityPage() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) redirect("/login");
  return (
    <Shell userPhone={userPhone}>
      <DashTopbar title="productivity" />
      <DashPageBody>
        <PageHead
          title="Productivity"
          subtitle="Habits, focus sessions, and expenses tracked across all your conversations."
          badge={{ label: "Self & money", color: "#D8CCFF" }}
        />
        <ProductivityContent />
      </DashPageBody>
    </Shell>
  );
}
