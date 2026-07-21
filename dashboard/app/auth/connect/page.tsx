import { redirect } from "next/navigation";
import { getCurrentUserPhone } from "@/lib/session";
import { ComposioConnectClient } from "./composio-connect-client";

export default async function ConnectGoogleApps({
  searchParams,
}: {
  searchParams: { client?: string };
}) {
  if (!await getCurrentUserPhone()) redirect("/login");
  return <ComposioConnectClient desktop={searchParams.client === "desktop"} />;
}
