import { redirect } from "next/navigation";
import { getCurrentUserPhone } from "@/lib/session";
import { Shell } from "@/components/shell";
import { DashTopbar, DashPageBody, PageHead } from "@/components/dash-page";
import { NotesContent } from "./notes-content";

export const dynamic = "force-dynamic";

export default async function NotesPage() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) redirect("/login");
  return (
    <Shell userPhone={userPhone}>
      <DashTopbar title="notes" />
      <DashPageBody>
        <PageHead
          title="Notes & Knowledge"
          subtitle="Search across notes, reading list, and team knowledge base — all captured via WhatsApp."
          badge={{ label: "Knowledge", color: "#FFB1D8" }}
        />
        <NotesContent />
      </DashPageBody>
    </Shell>
  );
}
