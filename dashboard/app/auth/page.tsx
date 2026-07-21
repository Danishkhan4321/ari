import { redirect } from "next/navigation";

export default function LegacyAuthRedirect() {
  redirect("/login");
}
