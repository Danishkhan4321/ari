import { redirect } from "next/navigation";
import { getCurrentUserPhone } from "@/lib/session";
import { Shell } from "@/components/shell";
import { DashTopbar, DashPageBody, PageHead } from "@/components/dash-page";
import { TranscriptionsContent } from "./transcriptions-content";

export const dynamic = "force-dynamic";

export default async function TranscriptionsPage() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) redirect("/login");
  return (
    <Shell userPhone={userPhone}>
      <DashTopbar title="Flowtype" />
      <DashPageBody>
        <PageHead
          title="Flowtype history"
          subtitle="Your 10 latest Flowtype transcripts, saved locally on this device."
          badge={{ label: "Voice to text", color: "#8f5ca3" }}
        />
        <TranscriptionsContent />
      </DashPageBody>
    </Shell>
  );
}
