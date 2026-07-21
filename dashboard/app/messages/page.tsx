import { redirect } from "next/navigation";
import { getCurrentUserPhone } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function MessagesPage() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) redirect("/login");
  redirect("/team#tab=chat");
}
