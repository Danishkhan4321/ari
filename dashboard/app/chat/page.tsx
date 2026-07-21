import { redirect } from "next/navigation";
import { getCurrentUserPhone } from "@/lib/session";
import { ChatClient } from "./chat-client";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const userPhone = await getCurrentUserPhone();
  if (!userPhone) redirect("/login");
  return <ChatClient userPhone={userPhone} />;
}
